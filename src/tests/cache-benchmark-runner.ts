import { PathClassifier } from '../ai/classifier';
import { OllamaClient } from '../ai/ollama-client';
import { classifyByRules } from '../ai/rules';
import type { AiEvidencePayload, Classification } from '../ai/types';
import { TraceLogger } from '../observability/logger';
import { CACHE_BENCHMARK_100, BENCHMARK_METADATA } from './cache-benchmark-100';

function readNumberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid value for ${name}: ${String(raw)}`);
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
    console.log(`✓ ${label}: model ready (${Math.round(performance.now() - startedAt)} ms).`);
    return true;
  } catch (error) {
    console.log(`! ${label}: inconclusive warm-up: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function recoverModel(ollama: OllamaClient, cooldownMs: number, recoveryTimeoutMs: number): Promise<boolean> {
  console.log('↻ Hard recovery: unloading model from memory...');
  try {
    await ollama.unloadModel();
    console.log('✓ Model:       unloaded from memory');
  } catch (error) {
    console.log(`! Model:       could not unload cleanly: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (cooldownMs > 0) {
    console.log(`↻ Cooldown:    ${cooldownMs} ms before warm-up`);
    await sleep(cooldownMs);
  }

  try {
    await ollama.health();
    console.log('✓ Ollama:      server active');
  } catch (error) {
    console.log(`! Ollama:      server unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  console.log(`↻ Warm-up:     recovery timeout ${recoveryTimeoutMs} ms`);
  return warmupModel(ollama, 'Recovery', recoveryTimeoutMs);
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

  if (selected.length === 0) throw new Error(`No cases for offset=${offset} limit=${limit}`);

  console.log(`\n${BENCHMARK_METADATA.name}`);
  console.log('════════════════════════════════════════════════════');
  console.log(`Version:          ${BENCHMARK_METADATA.version}`);
  console.log(`Total cases:      ${CACHE_BENCHMARK_100.length}`);
  console.log(`Batch:            ${offset + 1}-${offset + selected.length}`);
  console.log(`Model:            ${ollama.getModel()}`);
  console.log(`Test timeout:     ${timeoutMs} ms`);
  console.log(`Cooldown:         ${cooldownMs} ms after timeout`);
  console.log(`Recycle:          after ${recycleAfterTimeouts} consecutive timeouts`);
  console.log(`Recovery timeout: ${recoveryTimeoutMs} ms`);
  console.log('AI contract:      Gemma analyzes evidence; it never decides SAFE_CACHE.');
  console.log('Critical metric:  bad effective SAFE_CACHE = 0.');
  console.log('AI quality:       exact / conservative / dangerous evidence.');
  console.log('Note: this benchmark uses synthetic paths; ArtifactProfiler is evaluated with real paths.');
  console.log('No file is deleted or modified.');

  const status = await ollama.health();
  const modelPresent = status.models.some((name) => name.startsWith(ollama.getModel()));
  if (!modelPresent) throw new Error(`Model ${ollama.getModel()} is not available in Ollama.`);

  console.log('🔥 Warming up Gemma...');
  await warmupModel(ollama, 'Start', recoveryTimeoutMs);

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
    console.log(`Family:      ${test.appFamily}`);
    console.log(`Artifact:    ${test.artifactType}`);
    console.log(`Path:        ${test.path}`);
    console.log(`Size:        ${test.sizeMb} MB`);
    console.log(`Expected:    ${test.expected}`);
    console.log(`Difficulty:  ${test.difficulty}`);

    const ruleResult = classifyByRules(test.path);
    let modelActual = 'SKIPPED_BY_RULE';
    let effective;
    let latencyMs: number | null = null;

    if (ruleResult) {
      skippedAiByRule += 1;
      effective = ruleResult;
      console.log('⚡ Gemma:      SKIPPED (local rule is sufficient)');
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
        console.log(`🤖 Gemma evidence (${Math.round(ai.confidence * 100)}%)`);
        console.log(`   Regenerable: ${ai.regenerability}`);
        console.log(`   Data risk:   ${ai.userDataRisk}`);
        console.log(`   Latency:     ${latencyMs} ms`);
        console.log(`   Evidence:    ${ai.evidence.join(' | ')}`);
        console.log(`   Reason:      ${ai.reason}`);
        console.log(`   Quality:     ${quality.toUpperCase()}`);

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
        console.log(`   Latency:    ${latencyMs} ms`);
        console.log(`   Reason:     ${message}`);
        effective = await classifier.fallbackFromAiError(test.path, error);

        if (isTimeout) {
          if (consecutiveTimeouts < recycleAfterTimeouts) {
            softRecoveries += 1;
            console.log(`↻ Soft recovery: ${cooldownMs} ms; keeping the model loaded`);
            if (cooldownMs > 0) await sleep(cooldownMs);
            try {
              await ollama.health();
              console.log('✓ Ollama:      server active; continuing without unload');
            } catch (healthError) {
              console.log(`! Ollama:      not responding: ${healthError instanceof Error ? healthError.message : String(healthError)}`);
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

    console.log(`🛡️ System:     ${effective.classification}`);
    console.log(`   Source:     ${effective.source}`);
    console.log(`   Reason:     ${effective.reason}`);
    console.log(`✅ Safety:     ${unsafe ? 'CRITICAL FAILURE' : 'PASS'}`);

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
  console.log('BATCH SUMMARY');
  console.log(`Total cases:                 ${total}`);
  console.log(`Gemma skipped by rules:      ${skippedAiByRule}`);
  console.log(`Gemma actually evaluated:    ${aiEvaluated}`);
  console.log(`Valid responses:             ${validModelResponses}/${aiEvaluated}`);
  console.log(`Exact evidence:              ${evidenceExact}/${validModelResponses}`);
  console.log(`Conservative evidence:       ${evidenceConservative}`);
  console.log(`Dangerous evidence:          ${evidenceDangerous}`);
  console.log(`Gemma technical errors:      ${modelErrors}/${aiEvaluated}`);
  console.log(`Gemma timeouts:              ${modelTimeouts}/${aiEvaluated}`);
  console.log(`Average successful latency:  ${averageLatency ?? 'n/a'} ms`);
  console.log(`Successful p50 latency:      ${p50 ?? 'n/a'} ms`);
  console.log(`Successful p95 latency:      ${p95 ?? 'n/a'} ms`);
  console.log(`Longest attempt:             ${maxAttempt ?? 'n/a'} ms`);
  console.log(`Before first timeout:        ${firstTimeoutAfterAiCases ?? 'no timeout'} successful inferences`);
  console.log(`Max timeout streak:          ${maxTimeoutStreak}`);
  console.log(`Soft recoveries:             ${softRecoveries}`);
  console.log(`Successful hard recoveries:  ${recoveriesSucceeded}/${recoveriesAttempted}`);
  console.log(`AnSysWarden safety:          ${systemSafetyPass}/${total}`);
  console.log(`Bad effective SAFE_CACHE:    ${dangerousEffectiveSafe}`);
  console.log(`JSONL trace:                 ${logger.logFile}`);

  if (dangerousEffectiveSafe > 0) {
    console.log('\n🔴 CRITICAL FAILURE: the system authorized SAFE_CACHE in one or more unsafe cases.');
    process.exitCode = 2;
  } else {
    console.log('\n🟢 AI has no authority to authorize SAFE_CACHE, and there were no effective false SAFE_CACHE results.');
  }
}

main().catch((error) => {
  console.error('[AnSysWarden benchmark] Error:', error);
  process.exitCode = 1;
});
