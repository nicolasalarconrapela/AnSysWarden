import { OllamaClient } from '../ai/ollama-client';
import type { AiEvidencePayload } from '../ai/types';
import { getLanguage } from '../i18n';
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

function pick(en: string, es: string): string {
  return getLanguage() === 'es' ? es : en;
}

function readNumberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const parsed = Number.parseInt(process.argv[index + 1] ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(pick(`Invalid value for ${name}`, `Valor inválido para ${name}`));
  }
  return parsed;
}

function readModelsArg(): string[] | null {
  const index = process.argv.indexOf('--models');
  if (index === -1) return null;
  const value = process.argv[index + 1] ?? '';
  const models = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (models.length === 0) {
    throw new Error(pick('Use --models model1,model2', 'Usa --models modelo1,modelo2'));
  }
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
    return ai.regenerability === 'likely' && ai.userDataRisk === 'low' ? 'exact' : 'conservative';
  }
  if (expected === 'PROTECT') {
    if (ai.userDataRisk === 'high' || ai.regenerability === 'unlikely') return 'exact';
    if (ai.regenerability === 'likely' && ai.userDataRisk === 'low') return 'dangerous';
    return 'conservative';
  }
  if (ai.regenerability === 'unknown' && (ai.userDataRisk === 'unknown' || ai.userDataRisk === 'medium')) return 'exact';
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

  console.log('\n════════════════════════════════════════════════════');
  console.log(`${pick('MODEL', 'MODELO')}: ${model}`);
  console.log('════════════════════════════════════════════════════');

  const warmupCase = MODEL_COMPARISON_CORE[0];
  const warmupStartedAt = performance.now();
  try {
    await client.analyzePath(warmupCase.path, warmupTimeoutMs, warmupCase.profile);
    coldStartMs = Math.round(performance.now() - warmupStartedAt);
    console.log(`✓ ${pick('Warm-up succeeded', 'Calentamiento correcto')}: ${coldStartMs} ms`);
    console.log(pick(
      '  From this point on, latency measures the already-loaded model.',
      '  A partir de aquí, la latencia mide el modelo ya cargado.',
    ));
  } catch (error) {
    coldStartMs = Math.round(performance.now() - warmupStartedAt);
    errors = 1;
    skipped = MODEL_COMPARISON_CORE.length;
    console.log(`✗ ${pick('Warm-up failed after', 'El calentamiento falló tras')} ${coldStartMs} ms: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`! ${pick(
      `Skipping all ${skipped} CORE cases to avoid queueing requests behind a model that failed to load.`,
      `Se omiten los ${skipped} casos CORE para evitar encolar peticiones tras un modelo que no pudo cargar.`,
    )}`);
    try { await client.unloadModel(); } catch { /* Warm-up already failed; unload failure does not count as a second quality error. */ }
    return { model, exact, conservative, dangerous, errors, skipped, coldStartMs, averageMs: null, p50Ms: null, p95Ms: null };
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
      console.log(`  expected=${test.expected} regen=${ai.regenerability} risk=${ai.userDataRisk} ${durationMs} ms`);
    } catch (error) {
      errors += 1;
      const durationMs = Math.round(performance.now() - startedAt);
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = message.toLowerCase().includes('timeout');
      consecutiveTimeouts = isTimeout ? consecutiveTimeouts + 1 : 0;
      console.log(`✗ ${test.id} ${test.label}: ${message} (${durationMs} ms)`);

      if (consecutiveTimeouts >= maxConsecutiveTimeouts) {
        skipped = MODEL_COMPARISON_CORE.length - index - 1;
        console.log(`! ${pick('Stopping', 'Deteniendo')} ${model}: ${consecutiveTimeouts} ${pick('consecutive timeouts', 'timeouts consecutivos')}.`);
        console.log(`! ${pick('Remaining cases skipped', 'Casos restantes omitidos')}: ${skipped}`);
        break;
      }
    }
  }

  try { await client.unloadModel(); } catch { /* Does not affect score; this only attempts to free memory between models. */ }

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

  if (installed.length === 0) {
    throw new Error(pick('No models are installed in Ollama.', 'No hay modelos instalados en Ollama.'));
  }

  const selected = requestedModels ?? installed;
  const missing = selected.filter((model) => !installed.some((name) => name === model || name.startsWith(`${model}:`)));
  if (missing.length > 0) {
    throw new Error(pick(`Models not installed: ${missing.join(', ')}`, `Modelos no instalados: ${missing.join(', ')}`));
  }

  console.log(`\n${pick('AnSysWarden · Mobile Model Comparison', 'AnSysWarden · Comparación de modelos móviles')}`);
  console.log('════════════════════════════════════════════════════');
  console.log(`${pick('CORE cases', 'Casos CORE')}:        ${MODEL_COMPARISON_CORE.length}`);
  console.log(`${pick('Max warm-up', 'Calentamiento máx.')}:       ${warmupTimeoutMs} ms`);
  console.log(`${pick('Timeout/case', 'Timeout/caso')}:      ${timeoutMs} ms`);
  console.log(`${pick('Model cutoff', 'Corte del modelo')}:      ${maxConsecutiveTimeouts} ${pick('consecutive timeouts', 'timeouts consecutivos')}`);
  console.log(`${pick('Models', 'Modelos')}:            ${selected.join(', ')}`);
  console.log(pick(
    'Criterion: avoid dangerous analysis first; then compare quality and speed.',
    'Criterio: evitar primero análisis peligrosos; después comparar calidad y velocidad.',
  ));
  console.log(pick(
    'Cold start is measured separately and does NOT affect loaded-model p50/p95 latency.',
    'El arranque en frío se mide aparte y NO afecta a la latencia p50/p95 del modelo ya cargado.',
  ));
  console.log(pick(
    'No file is deleted or modified. Profiles are synthetic and controlled.',
    'No se borra ni modifica ningún archivo. Los perfiles son sintéticos y controlados.',
  ));

  const scores: ModelScore[] = [];
  for (const model of selected) {
    scores.push(await evaluateModel(model, timeoutMs, warmupTimeoutMs, maxConsecutiveTimeouts, logger));
  }

  const ordered = rank(scores);
  console.log('\n════════════════════════════════════════════════════');
  console.log(pick('FINAL RESULT', 'RESULTADO FINAL'));
  console.log('════════════════════════════════════════════════════');
  console.log(pick(
    'Model                  Exact  Conserv.  Danger  Error  Skip  Cold ms  p50 ms  p95 ms',
    'Modelo                 Exact  Conserv.  Peligro Error  Omit. Frío ms  p50 ms  p95 ms',
  ));
  for (const score of ordered) {
    console.log(`${score.model.padEnd(22)} ${String(score.exact).padStart(5)}  ${String(score.conservative).padStart(8)}  ${String(score.dangerous).padStart(6)}  ${String(score.errors).padStart(5)}  ${String(score.skipped).padStart(4)}  ${String(score.coldStartMs ?? 'n/a').padStart(7)}  ${String(score.p50Ms ?? 'n/a').padStart(6)}  ${String(score.p95Ms ?? 'n/a').padStart(6)}`);
  }

  const winner = ordered[0];
  console.log(`\n🥇 ${pick('Best balance in this run', 'Mejor equilibrio en esta ejecución')}: ${winner.model}`);
  console.log(`   ${pick('Exact', 'Exactas')}: ${winner.exact}/${MODEL_COMPARISON_CORE.length}`);
  console.log(`   ${pick('Dangerous analyses', 'Análisis peligrosos')}: ${winner.dangerous}`);
  console.log(`   ${pick('Errors', 'Errores')}: ${winner.errors}`);
  console.log(`   ${pick('Skipped', 'Omitidos')}: ${winner.skipped}`);
  console.log(`   ${pick('Cold start', 'Arranque en frío')}: ${winner.coldStartMs ?? 'n/a'} ms`);
  console.log(`   ${pick('Loaded p50', 'p50 cargado')}: ${winner.p50Ms ?? 'n/a'} ms`);
  console.log(`${pick('JSONL trace', 'Traza JSONL')}: ${logger.logFile}`);
}

main().catch((error) => {
  console.error('[AnSysWarden models] Error:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
