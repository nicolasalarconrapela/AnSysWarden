import { OllamaClient } from '../ai/ollama-client';
import type { AiEvidencePayload } from '../ai/types';
import { TraceLogger } from '../observability/logger';
import { MODEL_COMPARISON_CORE, type CoreExpectation } from './model-comparison-dataset';

interface ModelScore {
  model: string;
  exact: number;
  conservative: number;
  dangerous: number;
  errors: number;
  skipped: number;
  coldStartMs: number | null;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

type Quality = 'exact' | 'conservative' | 'dangerous';

function readNumberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const parsed = Number.parseInt(process.argv[index + 1] ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Valor inválido para ${name}`);
  return parsed;
}

function readModelsArg(): string[] | null {
  const index = process.argv.indexOf('--models');
  if (index === -1) return null;
  const value = process.argv[index + 1] ?? '';
  const models = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (models.length === 0) throw new Error('Usa --models modelo1,modelo2');
  return models;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)];
}

function evaluate(expected: CoreExpectation, ai: AiEvidencePayload): Quality {
  if (expected === 'REGENERABLE') {
    return ai.regenerability === 'likely' && ai.userDataRisk === 'low'
      ? 'exact'
      : 'conservative';
  }

  if (expected === 'PROTECT') {
    if (ai.userDataRisk === 'high' || ai.regenerability === 'unlikely') return 'exact';
    if (ai.regenerability === 'likely' && ai.userDataRisk === 'low') return 'dangerous';
    return 'conservative';
  }

  if (
    ai.regenerability === 'unknown'
    && (ai.userDataRisk === 'unknown' || ai.userDataRisk === 'medium')
  ) {
    return 'exact';
  }
  if (ai.regenerability === 'likely' && ai.userDataRisk === 'low') return 'dangerous';
  return 'conservative';
}

async function evaluateModel(
  model: string,
  timeoutMs: number,
  warmupTimeoutMs: number,
  maxConsecutiveTimeouts: number,
  logger: TraceLogger,
): Promise<ModelScore> {
  const client = new OllamaClient(undefined, model, logger);
  let exact = 0;
  let conservative = 0;
  let dangerous = 0;
  let errors = 0;
  let skipped = 0;
  let consecutiveTimeouts = 0;
  let coldStartMs: number | null = null;
  const latencies: number[] = [];

  console.log(`\n════════════════════════════════════════════════════`);
  console.log(`MODELO: ${model}`);
  console.log('════════════════════════════════════════════════════');

  const warmupCase = MODEL_COMPARISON_CORE[0];
  const warmupStartedAt = performance.now();
  try {
    await client.analyzePath(warmupCase.path, warmupTimeoutMs, warmupCase.profile);
    coldStartMs = Math.round(performance.now() - warmupStartedAt);
    console.log(`✓ Warm-up correcto: ${coldStartMs} ms`);
    console.log('  A partir de aquí medimos el modelo ya cargado en memoria.');
  } catch (error) {
    coldStartMs = Math.round(performance.now() - warmupStartedAt);
    errors = 1;
    skipped = MODEL_COMPARISON_CORE.length;
    console.log(`✗ Warm-up fallido tras ${coldStartMs} ms: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`! Se omiten los ${skipped} casos CORE para no acumular peticiones detrás de un modelo que no terminó de cargar.`);

    try {
      await client.unloadModel();
    } catch {
      // El warm-up ya falló; no convertimos la descarga de memoria en un segundo error de calidad.
    }

    return {
      model,
      exact,
      conservative,
      dangerous,
      errors,
      skipped,
      coldStartMs,
      averageMs: null,
      p50Ms: null,
      p95Ms: null,
    };
  }

  for (let index = 0; index < MODEL_COMPARISON_CORE.length; index += 1) {
    const test = MODEL_COMPARISON_CORE[index];
    const startedAt = performance.now();
    try {
      const ai = await client.analyzePath(test.path, timeoutMs, test.profile);
      const durationMs = Math.round(performance.now() - startedAt);
      latencies.push(durationMs);
      consecutiveTimeouts = 0;
      const quality = evaluate(test.expected, ai);

      if (quality === 'exact') exact += 1;
      else if (quality === 'conservative') conservative += 1;
      else dangerous += 1;

      const marker = quality === 'exact' ? '✓' : quality === 'conservative' ? '~' : '!';
      console.log(`${marker} ${test.id} ${test.label}`);
      console.log(`  esperado=${test.expected} regen=${ai.regenerability} riesgo=${ai.userDataRisk} ${durationMs} ms`);
    } catch (error) {
      errors += 1;
      const durationMs = Math.round(performance.now() - startedAt);
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = message.toLowerCase().includes('timeout');
      consecutiveTimeouts = isTimeout ? consecutiveTimeouts + 1 : 0;
      console.log(`✗ ${test.id} ${test.label}: ${message} (${durationMs} ms)`);

      if (consecutiveTimeouts >= maxConsecutiveTimeouts) {
        skipped = MODEL_COMPARISON_CORE.length - index - 1;
        console.log(`! Se abandona ${model}: ${consecutiveTimeouts} timeouts consecutivos.`);
        console.log(`! Casos restantes omitidos: ${skipped}`);
        break;
      }
    }
  }

  try {
    await client.unloadModel();
  } catch {
    // No afecta a la puntuación; solo intentamos liberar memoria entre modelos.
  }

  const averageMs = latencies.length > 0
    ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
    : null;

  return {
    model,
    exact,
    conservative,
    dangerous,
    errors,
    skipped,
    coldStartMs,
    averageMs,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
  };
}

function rank(scores: ModelScore[]): ModelScore[] {
  return [...scores].sort((a, b) => {
    if (a.dangerous !== b.dangerous) return a.dangerous - b.dangerous;
    if (a.errors !== b.errors) return a.errors - b.errors;
    if (a.skipped !== b.skipped) return a.skipped - b.skipped;
    if (a.exact !== b.exact) return b.exact - a.exact;
    return (a.p50Ms ?? Number.MAX_SAFE_INTEGER) - (b.p50Ms ?? Number.MAX_SAFE_INTEGER);
  });
}

async function main(): Promise<void> {
  const timeoutMs = readNumberArg('--timeout-ms', 15_000);
  const warmupTimeoutMs = readNumberArg('--warmup-timeout-ms', 120_000);
  const maxConsecutiveTimeouts = readNumberArg('--max-timeouts', 3);
  const requestedModels = readModelsArg();
  const logger = new TraceLogger();
  const discovery = new OllamaClient(undefined, undefined, logger);
  const status = await discovery.health();
  const installed = [...new Set(status.models)].sort();

  if (installed.length === 0) throw new Error('No hay modelos instalados en Ollama.');

  const selected = requestedModels ?? installed;
  const missing = selected.filter((model) => !installed.some((name) => name === model || name.startsWith(`${model}:`)));
  if (missing.length > 0) {
    throw new Error(`Modelos no instalados: ${missing.join(', ')}`);
  }

  console.log('\nAnSysWarden · Comparador de modelos móviles');
  console.log('════════════════════════════════════════════════════');
  console.log(`Casos CORE:       ${MODEL_COMPARISON_CORE.length}`);
  console.log(`Warm-up máximo:   ${warmupTimeoutMs} ms`);
  console.log(`Timeout/caso:     ${timeoutMs} ms`);
  console.log(`Corte modelo:     ${maxConsecutiveTimeouts} timeouts consecutivos`);
  console.log(`Modelos:          ${selected.join(', ')}`);
  console.log('Criterio: primero evitar análisis peligrosos; después calidad y velocidad.');
  console.log('El arranque en frío se mide aparte y NO contamina la velocidad p50/p95 del modelo ya cargado.');
  console.log('No se borra ni modifica ningún archivo. Los perfiles son sintéticos y controlados.');

  const scores: ModelScore[] = [];
  for (const model of selected) {
    scores.push(await evaluateModel(model, timeoutMs, warmupTimeoutMs, maxConsecutiveTimeouts, logger));
  }

  const ordered = rank(scores);
  console.log('\n════════════════════════════════════════════════════');
  console.log('RESULTADO FINAL');
  console.log('════════════════════════════════════════════════════');
  console.log('Modelo                 Exactas  Conserv.  Peligro  Error  Omit.  Cold ms  p50 ms  p95 ms');
  for (const score of ordered) {
    console.log(
      `${score.model.padEnd(22)} ${String(score.exact).padStart(7)}  ${String(score.conservative).padStart(8)}  ${String(score.dangerous).padStart(7)}  ${String(score.errors).padStart(5)}  ${String(score.skipped).padStart(5)}  ${String(score.coldStartMs ?? 'n/a').padStart(7)}  ${String(score.p50Ms ?? 'n/a').padStart(6)}  ${String(score.p95Ms ?? 'n/a').padStart(6)}`,
    );
  }

  const winner = ordered[0];
  console.log(`\n🥇 Mejor equilibrio de esta tanda: ${winner.model}`);
  console.log(`   Exactas: ${winner.exact}/${MODEL_COMPARISON_CORE.length}`);
  console.log(`   Análisis peligrosos: ${winner.dangerous}`);
  console.log(`   Errores: ${winner.errors}`);
  console.log(`   Omitidos: ${winner.skipped}`);
  console.log(`   Arranque en frío: ${winner.coldStartMs ?? 'n/a'} ms`);
  console.log(`   p50 ya cargado: ${winner.p50Ms ?? 'n/a'} ms`);
  console.log(`Traza JSONL: ${logger.logFile}`);
}

main().catch((error) => {
  console.error('[AnSysWarden models] Error:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
