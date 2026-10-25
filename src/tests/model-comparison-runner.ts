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
  logger: TraceLogger,
): Promise<ModelScore> {
  const client = new OllamaClient(undefined, model, logger);
  let exact = 0;
  let conservative = 0;
  let dangerous = 0;
  let errors = 0;
  const latencies: number[] = [];

  console.log(`\n════════════════════════════════════════════════════`);
  console.log(`MODELO: ${model}`);
  console.log('════════════════════════════════════════════════════');

  try {
    const warmupCase = MODEL_COMPARISON_CORE[0];
    await client.analyzePath(warmupCase.path, Math.max(timeoutMs, 30_000), warmupCase.profile);
    console.log('✓ Warm-up correcto');
  } catch (error) {
    console.log(`! Warm-up no concluyente: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const test of MODEL_COMPARISON_CORE) {
    const startedAt = performance.now();
    try {
      const ai = await client.analyzePath(test.path, timeoutMs, test.profile);
      const durationMs = Math.round(performance.now() - startedAt);
      latencies.push(durationMs);
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
      console.log(`✗ ${test.id} ${test.label}: ${error instanceof Error ? error.message : String(error)} (${durationMs} ms)`);
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
    averageMs,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
  };
}

function rank(scores: ModelScore[]): ModelScore[] {
  return [...scores].sort((a, b) => {
    if (a.dangerous !== b.dangerous) return a.dangerous - b.dangerous;
    if (a.errors !== b.errors) return a.errors - b.errors;
    if (a.exact !== b.exact) return b.exact - a.exact;
    return (a.p50Ms ?? Number.MAX_SAFE_INTEGER) - (b.p50Ms ?? Number.MAX_SAFE_INTEGER);
  });
}

async function main(): Promise<void> {
  const timeoutMs = readNumberArg('--timeout-ms', 15_000);
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
  console.log(`Casos CORE:    ${MODEL_COMPARISON_CORE.length}`);
  console.log(`Timeout/caso:  ${timeoutMs} ms`);
  console.log(`Modelos:       ${selected.join(', ')}`);
  console.log('Criterio: primero evitar análisis peligrosos; después calidad y velocidad.');
  console.log('No se borra ni modifica ningún archivo. Los perfiles son sintéticos y controlados.');

  const scores: ModelScore[] = [];
  for (const model of selected) {
    scores.push(await evaluateModel(model, timeoutMs, logger));
  }

  const ordered = rank(scores);
  console.log('\n════════════════════════════════════════════════════');
  console.log('RESULTADO FINAL');
  console.log('════════════════════════════════════════════════════');
  console.log('Modelo                 Exactas  Conserv.  Peligro  Error  p50 ms  p95 ms');
  for (const score of ordered) {
    console.log(
      `${score.model.padEnd(22)} ${String(score.exact).padStart(7)}  ${String(score.conservative).padStart(8)}  ${String(score.dangerous).padStart(7)}  ${String(score.errors).padStart(5)}  ${String(score.p50Ms ?? 'n/a').padStart(6)}  ${String(score.p95Ms ?? 'n/a').padStart(6)}`,
    );
  }

  const winner = ordered[0];
  console.log(`\n🥇 Mejor equilibrio de esta tanda: ${winner.model}`);
  console.log(`   Exactas: ${winner.exact}/${MODEL_COMPARISON_CORE.length}`);
  console.log(`   Análisis peligrosos: ${winner.dangerous}`);
  console.log(`   Errores: ${winner.errors}`);
  console.log(`   p50: ${winner.p50Ms ?? 'n/a'} ms`);
  console.log(`Traza JSONL: ${logger.logFile}`);
}

main().catch((error) => {
  console.error('[AnSysWarden models] Error:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
