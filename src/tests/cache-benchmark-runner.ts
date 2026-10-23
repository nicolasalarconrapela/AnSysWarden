import { PathClassifier } from '../ai/classifier';
import { OllamaClient } from '../ai/ollama-client';
import { classifyByRules } from '../ai/rules';
import { TraceLogger } from '../observability/logger';
import { CACHE_BENCHMARK_100, BENCHMARK_METADATA } from './cache-benchmark-100';

function readNumberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Valor inválido para ${name}: ${String(raw)}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)];
}

async function main(): Promise<void> {
  const offset = readNumberArg('--offset', 0);
  const limit = readNumberArg('--limit', 10);
  const timeoutMs = readNumberArg('--timeout-ms', 10_000);
  const cooldownMs = readNumberArg('--cooldown-ms', 1_500);

  // El timeout corto se aplica SOLO a este proceso de benchmark.
  // No cambia el timeout general de AnSysWarden ni modifica configuración persistente.
  process.env.ANSYSWARDEN_AI_TIMEOUT_MS = String(timeoutMs);

  const logger = new TraceLogger();
  const ollama = new OllamaClient(undefined, undefined, logger);
  const classifier = new PathClassifier(logger, ollama);
  const selected = CACHE_BENCHMARK_100.slice(offset, offset + limit);

  if (selected.length === 0) {
    throw new Error(`No hay casos para offset=${offset} limit=${limit}`);
  }

  console.log(`\n${BENCHMARK_METADATA.name}`);
  console.log('════════════════════════════════════════════════════');
  console.log(`Versión:       ${BENCHMARK_METADATA.version}`);
  console.log(`Casos totales: ${CACHE_BENCHMARK_100.length}`);
  console.log(`Tanda:         ${offset + 1}-${offset + selected.length}`);
  console.log(`Modelo:        ${ollama.getModel()}`);
  console.log(`Timeout test:  ${timeoutMs} ms`);
  console.log(`Cooldown:      ${cooldownMs} ms tras timeout`);
  console.log('Métrica crítica: falsos SAFE_CACHE efectivos.');
  console.log('Modo rápido: una sola inferencia de Gemma por caso como máximo.');
  console.log('No se borra ni modifica ningún archivo.');

  const status = await ollama.health();
  const modelPresent = status.models.some((name) => name.startsWith(ollama.getModel()));
  if (!modelPresent) {
    throw new Error(`El modelo ${ollama.getModel()} no está disponible en Ollama.`);
  }

  console.log('🔥 Warm-up de Gemma...');
  try {
    const startedAt = performance.now();
    await ollama.classifyPath('/benchmark/warmup/unknown-artifact');
    console.log(`✓ Modelo listo (${Math.round(performance.now() - startedAt)} ms).`);
  } catch (error) {
    console.log(`! Warm-up no concluyente: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`↻ Recuperación: ${cooldownMs} ms antes de continuar.`);
    await sleep(cooldownMs);
  }

  let modelCorrect = 0;
  let modelErrors = 0;
  let modelTimeouts = 0;
  let dangerousModelSafe = 0;
  let dangerousEffectiveSafe = 0;
  let systemSafetyPass = 0;
  let skippedAiByRule = 0;
  const successfulLatenciesMs: number[] = [];
  const attemptedLatenciesMs: number[] = [];

  for (let index = 0; index < selected.length; index += 1) {
    const test = selected[index];
    console.log('\n────────────────────────────────────────────────────');
    console.log(`${test.id}  ${offset + index + 1}/100`);
    console.log(`Familia:    ${test.appFamily}`);
    console.log(`Artefacto:  ${test.artifactType}`);
    console.log(`Ruta:       ${test.path}`);
    console.log(`Tamaño:     ${test.sizeMb} MB`);
    console.log(`Esperado:   ${test.expected}`);
    console.log(`Dificultad: ${test.difficulty}`);

    const ruleResult = classifyByRules(test.path);
    let modelActual = 'SKIPPED_BY_RULE';
    let effective;
    let latencyMs: number | null = null;

    if (ruleResult) {
      skippedAiByRule += 1;
      effective = ruleResult;
      console.log('⚡ Gemma:      OMITIDA (regla local suficiente)');
    } else {
      const startedAt = performance.now();
      try {
        const model = await ollama.classifyPath(test.path);
        latencyMs = Math.round(performance.now() - startedAt);
        attemptedLatenciesMs.push(latencyMs);
        successfulLatenciesMs.push(latencyMs);
        modelActual = model.classification;
        if (model.classification === test.expected) modelCorrect += 1;
        if (model.classification === 'SAFE_CACHE' && test.expected !== 'SAFE_CACHE') {
          dangerousModelSafe += 1;
        }
        console.log(`🤖 Gemma:      ${model.classification} (${Math.round(model.confidence * 100)}%)`);
        console.log(`   Latencia:   ${latencyMs} ms`);
        console.log(`   Motivo:     ${model.reason}`);
        effective = await classifier.applyAiRecommendation(test.path, model);
      } catch (error) {
        latencyMs = Math.round(performance.now() - startedAt);
        attemptedLatenciesMs.push(latencyMs);
        modelErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        const isTimeout = message.toLowerCase().includes('timeout');
        if (isTimeout) modelTimeouts += 1;

        console.log('🤖 Gemma:      ERROR');
        console.log(`   Latencia:   ${latencyMs} ms`);
        console.log(`   Motivo:     ${message}`);
        effective = await classifier.fallbackFromAiError(test.path, error);

        if (isTimeout && cooldownMs > 0) {
          console.log(`↻ Cooldown:    ${cooldownMs} ms antes del siguiente caso`);
          await sleep(cooldownMs);
          try {
            await ollama.health();
            console.log('✓ Ollama:      responde tras el timeout');
          } catch (healthError) {
            console.log(`! Ollama:      no responde tras el timeout: ${healthError instanceof Error ? healthError.message : String(healthError)}`);
          }
        }
      }
    }

    const unsafe = effective.classification === 'SAFE_CACHE' && test.expected !== 'SAFE_CACHE';
    if (unsafe) dangerousEffectiveSafe += 1;
    else systemSafetyPass += 1;

    console.log(`🛡️ Sistema:    ${effective.classification}`);
    console.log(`   Source:     ${effective.source}`);
    console.log(`   Motivo:     ${effective.reason}`);
    console.log(`✅ Seguridad:  ${unsafe ? 'FALLO CRÍTICO' : 'PASS'}`);

    await logger.info('benchmark.case', 'Caso del benchmark evaluado', {
      id: test.id,
      expected: test.expected,
      model_actual: modelActual,
      effective_actual: effective.classification,
      effective_source: effective.source,
      dangerous_effective_safe: unsafe,
      size_mb: test.sizeMb,
      category: test.category,
      difficulty: test.difficulty,
      ai_skipped_by_rule: Boolean(ruleResult),
      latency_ms: latencyMs,
      timeout_ms: timeoutMs,
    });
  }

  const total = selected.length;
  const aiEvaluated = total - skippedAiByRule;
  const averageLatency = successfulLatenciesMs.length > 0
    ? Math.round(successfulLatenciesMs.reduce((sum, value) => sum + value, 0) / successfulLatenciesMs.length)
    : null;
  const p50 = percentile(successfulLatenciesMs, 0.5);
  const p95 = percentile(successfulLatenciesMs, 0.95);
  const maxAttempt = attemptedLatenciesMs.length > 0 ? Math.max(...attemptedLatenciesMs) : null;

  console.log('\n════════════════════════════════════════════════════');
  console.log('RESUMEN DE LA TANDA');
  console.log(`Casos totales:              ${total}`);
  console.log(`Gemma omitida por reglas:   ${skippedAiByRule}`);
  console.log(`Gemma realmente evaluada:   ${aiEvaluated}`);
  console.log(`Gemma exacta:               ${modelCorrect}/${aiEvaluated}`);
  console.log(`Errores Gemma:              ${modelErrors}/${aiEvaluated}`);
  console.log(`Timeouts Gemma:             ${modelTimeouts}/${aiEvaluated}`);
  console.log(`Latencia media OK:          ${averageLatency ?? 'n/a'} ms`);
  console.log(`Latencia p50 OK:            ${p50 ?? 'n/a'} ms`);
  console.log(`Latencia p95 OK:            ${p95 ?? 'n/a'} ms`);
  console.log(`Mayor intento:              ${maxAttempt ?? 'n/a'} ms`);
  console.log(`SAFE_CACHE peligrosos IA:   ${dangerousModelSafe}`);
  console.log(`Seguridad AnSysWarden:      ${systemSafetyPass}/${total}`);
  console.log(`SAFE_CACHE efectivos malos: ${dangerousEffectiveSafe}`);
  console.log(`Traza JSONL:                ${logger.logFile}`);

  if (dangerousEffectiveSafe > 0) {
    console.log('\n🔴 FALLO CRÍTICO: el sistema autorizó SAFE_CACHE en uno o más casos no seguros.');
    process.exitCode = 2;
  } else {
    console.log('\n🟢 No hubo falsos SAFE_CACHE efectivos en esta tanda.');
  }
}

main().catch((error) => {
  console.error('[AnSysWarden benchmark] Error:', error);
  process.exitCode = 1;
});
