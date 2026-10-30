import { PathClassifier } from '../ai/classifier';
import { OllamaClient } from '../ai/ollama-client';
import { classifyByRules } from '../ai/rules';
import type { AiEvidencePayload, Classification } from '../ai/types';
import { getLanguage } from '../i18n';
import { TraceLogger } from '../observability/logger';
import { CACHE_BENCHMARK_100, BENCHMARK_METADATA } from './cache-benchmark-100';

function pick(en: string, es: string): string {
  return getLanguage() === 'es' ? es : en;
}

function readNumberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(pick(`Invalid value for ${name}: ${String(raw)}`, `Valor inválido para ${name}: ${String(raw)}`));
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

type EvidenceQuality = 'exact' | 'conservative' | 'dangerous';

function evaluateEvidence(expected: Classification, ai: AiEvidencePayload): EvidenceQuality {
  if (expected === 'SAFE_CACHE') {
    return ai.regenerability === 'likely' && ai.userDataRisk === 'low' ? 'exact' : 'conservative';
  }

  if (expected === 'USER_DATA') {
    if (ai.userDataRisk === 'high' || ai.regenerability === 'unlikely') return 'exact';
    if (ai.userDataRisk === 'low' && ai.regenerability === 'likely') return 'dangerous';
    return 'conservative';
  }

  // For REVIEW_REQUIRED, the correct behavior is to preserve uncertainty.
  // Claiming both likely regenerability and low risk is the dangerous equivalent
  // of the old direct SAFE_CACHE behavior.
  if (ai.regenerability === 'likely' && ai.userDataRisk === 'low') return 'dangerous';
  if (ai.regenerability === 'unknown' && (ai.userDataRisk === 'unknown' || ai.userDataRisk === 'medium')) return 'exact';
  return 'conservative';
}

async function warmupModel(ollama: OllamaClient, label: string, timeoutMs?: number): Promise<boolean> {
  const startedAt = performance.now();
  try {
    await ollama.analyzePath('/benchmark/warmup/unknown-artifact', timeoutMs);
    console.log(`✓ ${label}: ${pick('model ready', 'modelo listo')} (${Math.round(performance.now() - startedAt)} ms).`);
    return true;
  } catch (error) {
    console.log(`! ${label}: ${pick('inconclusive warm-up', 'calentamiento no concluyente')}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function recoverModel(ollama: OllamaClient, cooldownMs: number, recoveryTimeoutMs: number): Promise<boolean> {
  console.log(pick('↻ Hard recovery: unloading model from memory...', '↻ Recuperación fuerte: descargando el modelo de memoria...'));
  try {
    await ollama.unloadModel();
    console.log(pick('✓ Model:       unloaded from memory', '✓ Modelo:       descargado de memoria'));
  } catch (error) {
    console.log(`${pick('! Model:       could not unload cleanly', '! Modelo:       no se pudo descargar limpiamente')}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (cooldownMs > 0) {
    console.log(`↻ ${pick('Cooldown', 'Enfriamiento')}:    ${cooldownMs} ms ${pick('before warm-up', 'antes del calentamiento')}`);
    await sleep(cooldownMs);
  }

  try {
    await ollama.health();
    console.log(pick('✓ Ollama:      server active', '✓ Ollama:      servidor activo'));
  } catch (error) {
    console.log(`${pick('! Ollama:      server unavailable', '! Ollama:      servidor no disponible')}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  console.log(`↻ ${pick('Warm-up', 'Calentamiento')}:     ${pick('recovery timeout', 'timeout de recuperación')} ${recoveryTimeoutMs} ms`);
  return warmupModel(ollama, pick('Recovery', 'Recuperación'), recoveryTimeoutMs);
}

async function main(): Promise<void> {
  const offset = readNumberArg('--offset', 0);
  const limit = readNumberArg('--limit', 10);
  const timeoutMs = readNumberArg('--timeout-ms', 10_000);
  const cooldownMs = readNumberArg('--cooldown-ms', 1_500);
  const recoveryTimeoutMs = readNumberArg('--recovery-timeout-ms', 30_000);
  const recycleAfterTimeouts = readNumberArg('--recycle-after-timeouts', 2);

  process.env.ANSYSWARDEN_AI_TIMEOUT_MS = String(timeoutMs);

  const logger = new TraceLogger();
  const ollama = new OllamaClient(undefined, undefined, logger);
  const classifier = new PathClassifier(logger, ollama);
  const selected = CACHE_BENCHMARK_100.slice(offset, offset + limit);

  if (selected.length === 0) {
    throw new Error(pick(`No cases for offset=${offset} limit=${limit}`, `No hay casos para offset=${offset} limit=${limit}`));
  }

  console.log(`\n${BENCHMARK_METADATA.name}`);
  console.log('════════════════════════════════════════════════════');
  console.log(`${pick('Version', 'Versión')}:          ${BENCHMARK_METADATA.version}`);
  console.log(`${pick('Total cases', 'Casos totales')}:      ${CACHE_BENCHMARK_100.length}`);
  console.log(`${pick('Batch', 'Lote')}:            ${offset + 1}-${offset + selected.length}`);
  console.log(`${pick('Model', 'Modelo')}:            ${ollama.getModel()}`);
  console.log(`${pick('Test timeout', 'Timeout de prueba')}:     ${timeoutMs} ms`);
  console.log(`${pick('Cooldown', 'Enfriamiento')}:         ${cooldownMs} ms ${pick('after timeout', 'tras timeout')}`);
  console.log(`${pick('Recycle', 'Reciclado')}:          ${pick('after', 'tras')} ${recycleAfterTimeouts} ${pick('consecutive timeouts', 'timeouts consecutivos')}`);
  console.log(`${pick('Recovery timeout', 'Timeout recuperación')}: ${recoveryTimeoutMs} ms`);
  console.log(pick(
    'AI contract:      Gemma analyzes evidence; it never decides SAFE_CACHE.',
    'Contrato IA:      Gemma analiza evidencia; nunca decide SAFE_CACHE.',
  ));
  console.log(pick(
    'Critical metric:  bad effective SAFE_CACHE = 0.',
    'Métrica crítica:  SAFE_CACHE efectivo incorrecto = 0.',
  ));
  console.log(pick(
    'AI quality:       exact / conservative / dangerous evidence.',
    'Calidad IA:       evidencia exact / conservative / dangerous.',
  ));
  console.log(pick(
    'Note: this benchmark uses synthetic paths; ArtifactProfiler is evaluated with real paths.',
    'Nota: este benchmark usa rutas sintéticas; ArtifactProfiler se evalúa con rutas reales.',
  ));
  console.log(pick('No file is deleted or modified.', 'No se borra ni modifica ningún archivo.'));

  const status = await ollama.health();
  const modelPresent = status.models.some((name) => name.startsWith(ollama.getModel()));
  if (!modelPresent) {
    throw new Error(pick(
      `Model ${ollama.getModel()} is not available in Ollama.`,
      `El modelo ${ollama.getModel()} no está disponible en Ollama.`,
    ));
  }

  console.log(pick('🔥 Warming up Gemma...', '🔥 Calentando Gemma...'));
  await warmupModel(ollama, pick('Start', 'Inicio'), recoveryTimeoutMs);

  let evidenceExact = 0;
  let evidenceConservative = 0;
  let evidenceDangerous = 0;
  let modelErrors = 0;
  let modelTimeouts = 0;
  let dangerousEffectiveSafe = 0;
  let systemSafetyPass = 0;
  let skippedAiByRule = 0;
  let successfulAiCases = 0;
  let consecutiveTimeouts = 0;
  let maxTimeoutStreak = 0;
  let firstTimeoutAfterAiCases: number | null = null;
  let recoveriesAttempted = 0;
  let recoveriesSucceeded = 0;
  let softRecoveries = 0;
  const successfulLatenciesMs: number[] = [];
  const attemptedLatenciesMs: number[] = [];

  for (let index = 0; index < selected.length; index += 1) {
    const test = selected[index];
    console.log('\n────────────────────────────────────────────────────');
    console.log(`${test.id}  ${offset + index + 1}/100`);
    console.log(`${pick('Family', 'Familia')}:      ${test.appFamily}`);
    console.log(`${pick('Artifact', 'Artefacto')}:    ${test.artifactType}`);
    console.log(`${pick('Path', 'Ruta')}:        ${test.path}`);
    console.log(`${pick('Size', 'Tamaño')}:        ${test.sizeMb} MB`);
    console.log(`${pick('Expected', 'Esperado')}:    ${test.expected}`);
    console.log(`${pick('Difficulty', 'Dificultad')}:  ${test.difficulty}`);

    const ruleResult = classifyByRules(test.path);
    let modelActual = 'SKIPPED_BY_RULE';
    let effective;
    let latencyMs: number | null = null;

    if (ruleResult) {
      skippedAiByRule += 1;
      effective = ruleResult;
      console.log(pick(
        '⚡ Gemma:      SKIPPED (local rule is sufficient)',
        '⚡ Gemma:      OMITIDA (la regla local es suficiente)',
      ));
    } else {
      const startedAt = performance.now();
      try {
        const ai = await ollama.analyzePath(test.path);
        latencyMs = Math.round(performance.now() - startedAt);
        attemptedLatenciesMs.push(latencyMs);
        successfulLatenciesMs.push(latencyMs);
        successfulAiCases += 1;
        consecutiveTimeouts = 0;

        const quality = evaluateEvidence(test.expected, ai);
        if (quality === 'exact') evidenceExact += 1;
        else if (quality === 'conservative') evidenceConservative += 1;
        else evidenceDangerous += 1;

        modelActual = `regen=${ai.regenerability};risk=${ai.userDataRisk}`;
        console.log(`🤖 ${pick('Gemma evidence', 'Evidencia Gemma')} (${Math.round(ai.confidence * 100)}%)`);
        console.log(`   ${pick('Regenerable', 'Regenerable')}: ${ai.regenerability}`);
        console.log(`   ${pick('Data risk', 'Riesgo de datos')}:   ${ai.userDataRisk}`);
        console.log(`   ${pick('Latency', 'Latencia')}:     ${latencyMs} ms`);
        console.log(`   ${pick('Evidence', 'Evidencia')}:    ${ai.evidence.join(' | ')}`);
        console.log(`   ${pick('Reason', 'Motivo')}:      ${ai.reason}`);
        console.log(`   ${pick('Quality', 'Calidad')}:     ${quality.toUpperCase()}`);

        effective = await classifier.applyAiEvidence(test.path, ai);
      } catch (error) {
        latencyMs = Math.round(performance.now() - startedAt);
        attemptedLatenciesMs.push(latencyMs);
        modelErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        const isTimeout = message.toLowerCase().includes('timeout');

        if (isTimeout) {
          modelTimeouts += 1;
          consecutiveTimeouts += 1;
          maxTimeoutStreak = Math.max(maxTimeoutStreak, consecutiveTimeouts);
          if (firstTimeoutAfterAiCases === null) firstTimeoutAfterAiCases = successfulAiCases;
        } else {
          consecutiveTimeouts = 0;
        }

        console.log('🤖 Gemma:      ERROR');
        console.log(`   ${pick('Latency', 'Latencia')}:    ${latencyMs} ms`);
        console.log(`   ${pick('Reason', 'Motivo')}:     ${message}`);
        effective = await classifier.fallbackFromAiError(test.path, error);

        if (isTimeout) {
          if (consecutiveTimeouts < recycleAfterTimeouts) {
            softRecoveries += 1;
            console.log(`↻ ${pick('Soft recovery', 'Recuperación suave')}: ${cooldownMs} ms; ${pick('keeping the model loaded', 'manteniendo el modelo cargado')}`);
            if (cooldownMs > 0) await sleep(cooldownMs);
            try {
              await ollama.health();
              console.log(pick(
                '✓ Ollama:      server active; continuing without unload',
                '✓ Ollama:      servidor activo; se continúa sin descargar el modelo',
              ));
            } catch (healthError) {
              console.log(`${pick('! Ollama:      not responding', '! Ollama:      no responde')}: ${healthError instanceof Error ? healthError.message : String(healthError)}`);
            }
          } else {
            recoveriesAttempted += 1;
            const recovered = await recoverModel(ollama, cooldownMs, recoveryTimeoutMs);
            if (recovered) {
              recoveriesSucceeded += 1;
              consecutiveTimeouts = 0;
            }
          }
        }
      }
    }

    const unsafe = effective.classification === 'SAFE_CACHE' && test.expected !== 'SAFE_CACHE';
    if (unsafe) dangerousEffectiveSafe += 1;
    else systemSafetyPass += 1;

    console.log(`🛡️ ${pick('System', 'Sistema')}:     ${effective.classification}`);
    console.log(`   ${pick('Source', 'Fuente')}:     ${effective.source}`);
    console.log(`   ${pick('Reason', 'Motivo')}:     ${effective.reason}`);
    console.log(`✅ ${pick('Safety', 'Seguridad')}:     ${unsafe ? pick('CRITICAL FAILURE', 'FALLO CRÍTICO') : 'PASS'}`);

    await logger.info('benchmark.case', 'Benchmark case evaluated', {
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
      consecutive_timeouts: consecutiveTimeouts,
    });
  }

  const total = selected.length;
  const aiEvaluated = total - skippedAiByRule;
  const validModelResponses = aiEvaluated - modelErrors;
  const averageLatency = successfulLatenciesMs.length > 0
    ? Math.round(successfulLatenciesMs.reduce((sum, value) => sum + value, 0) / successfulLatenciesMs.length)
    : null;
  const p50 = percentile(successfulLatenciesMs, 0.5);
  const p95 = percentile(successfulLatenciesMs, 0.95);
  const maxAttempt = attemptedLatenciesMs.length > 0 ? Math.max(...attemptedLatenciesMs) : null;

  console.log('\n════════════════════════════════════════════════════');
  console.log(pick('BATCH SUMMARY', 'RESUMEN DEL LOTE'));
  console.log(`${pick('Total cases', 'Casos totales')}:                 ${total}`);
  console.log(`${pick('Gemma skipped by rules', 'Gemma omitida por reglas')}:      ${skippedAiByRule}`);
  console.log(`${pick('Gemma actually evaluated', 'Gemma evaluó realmente')}:    ${aiEvaluated}`);
  console.log(`${pick('Valid responses', 'Respuestas válidas')}:             ${validModelResponses}/${aiEvaluated}`);
  console.log(`${pick('Exact evidence', 'Evidencia exacta')}:              ${evidenceExact}/${validModelResponses}`);
  console.log(`${pick('Conservative evidence', 'Evidencia conservadora')}:       ${evidenceConservative}`);
  console.log(`${pick('Dangerous evidence', 'Evidencia peligrosa')}:          ${evidenceDangerous}`);
  console.log(`${pick('Gemma technical errors', 'Errores técnicos de Gemma')}:      ${modelErrors}/${aiEvaluated}`);
  console.log(`${pick('Gemma timeouts', 'Timeouts de Gemma')}:              ${modelTimeouts}/${aiEvaluated}`);
  console.log(`${pick('Average successful latency', 'Latencia media correcta')}:  ${averageLatency ?? 'n/a'} ms`);
  console.log(`${pick('Successful p50 latency', 'Latencia p50 correcta')}:      ${p50 ?? 'n/a'} ms`);
  console.log(`${pick('Successful p95 latency', 'Latencia p95 correcta')}:      ${p95 ?? 'n/a'} ms`);
  console.log(`${pick('Longest attempt', 'Intento más largo')}:             ${maxAttempt ?? 'n/a'} ms`);
  console.log(`${pick('Before first timeout', 'Antes del primer timeout')}:        ${firstTimeoutAfterAiCases ?? pick('no timeout', 'sin timeout')} ${pick('successful inferences', 'inferencias correctas')}`);
  console.log(`${pick('Max timeout streak', 'Racha máxima de timeouts')}:          ${maxTimeoutStreak}`);
  console.log(`${pick('Soft recoveries', 'Recuperaciones suaves')}:             ${softRecoveries}`);
  console.log(`${pick('Successful hard recoveries', 'Recuperaciones fuertes correctas')}:  ${recoveriesSucceeded}/${recoveriesAttempted}`);
  console.log(`${pick('AnSysWarden safety', 'Seguridad AnSysWarden')}:          ${systemSafetyPass}/${total}`);
  console.log(`${pick('Bad effective SAFE_CACHE', 'SAFE_CACHE efectivo incorrecto')}:    ${dangerousEffectiveSafe}`);
  console.log(`${pick('JSONL trace', 'Traza JSONL')}:                 ${logger.logFile}`);

  if (dangerousEffectiveSafe > 0) {
    console.log(pick(
      '\n🔴 CRITICAL FAILURE: the system authorized SAFE_CACHE in one or more unsafe cases.',
      '\n🔴 FALLO CRÍTICO: el sistema autorizó SAFE_CACHE en uno o más casos inseguros.',
    ));
    process.exitCode = 2;
  } else {
    console.log(pick(
      '\n🟢 AI has no authority to authorize SAFE_CACHE, and there were no effective false SAFE_CACHE results.',
      '\n🟢 La IA no tiene autoridad para autorizar SAFE_CACHE y no hubo falsos SAFE_CACHE efectivos.',
    ));
  }
}

main().catch((error) => {
  console.error(pick('[AnSysWarden benchmark] Error:', '[AnSysWarden benchmark] Error:'), error);
  process.exitCode = 1;
});
