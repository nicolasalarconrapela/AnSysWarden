import { resolve } from 'node:path';
import { PathClassifier } from './ai/classifier';
import { OllamaClient } from './ai/ollama-client';
import { TraceLogger } from './observability/logger';
import { LocalScanner, candidateLabel, formatBytes } from './scanner/scanner';
import { runAiSafetySuite, type SafetyCategory } from './tests/ai-safety';

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  magenta: '\u001b[35m',
  gray: '\u001b[90m',
};

function paint(text: string, code: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `${code}${text}${ANSI.reset}`;
}

function usage(): void {
  console.log('Usage:');
  console.log('  npx tsx src/cli.ts doctor');
  console.log('  npx tsx src/cli.ts classify <path>');
  console.log('  npx tsx src/cli.ts scan <path> [--min-mb N]');
  console.log('  npx tsx src/cli.ts test safety');
}

function printResult(result: Awaited<ReturnType<PathClassifier['classify']>>, logger: TraceLogger): void {
  const confidence = Math.round(result.confidence * 100);
  console.log('\nAnSysWarden');
  console.log('────────────────────────────────────────');
  console.log(`Path:           ${result.path}`);
  console.log(`Classification: ${result.classification}`);
  console.log(`Confidence:     ${confidence}%`);
  console.log(`Source:         ${result.source}`);
  console.log(`Reason:         ${result.reason}`);
  console.log('Action:         No files have been deleted.');
  console.log(`Run ID:         ${logger.runId}`);
  console.log(`Trace:          ${logger.logFile}`);
}

async function runDoctor(logger: TraceLogger): Promise<void> {
  const ollama = new OllamaClient(undefined, undefined, logger);

  console.log('\nAnSysWarden Doctor');
  console.log('────────────────────────────────────────');
  console.log(`Ollama host: ${ollama.getHost()}`);
  console.log(`Model:       ${ollama.getModel()}`);

  try {
    const status = await logger.span(
      'doctor.ollama',
      'Checking local Ollama',
      () => ollama.health(),
      { host: ollama.getHost(), model: ollama.getModel() },
    );

    console.log('Status:      OK');
    console.log(`Models:      ${status.models.length ? status.models.join(', ') : '(none)'}`);
    console.log(`Run ID:      ${logger.runId}`);
    console.log(`Trace:       ${logger.logFile}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Status:      ERROR');
    console.error(`Detail:      ${message}`);
    console.error(`Run ID:      ${logger.runId}`);
    console.error(`Trace:       ${logger.logFile}`);
    process.exitCode = 1;
  }
}

function parseMinMb(args: string[]): number | undefined {
  const index = args.indexOf('--min-mb');
  if (index === -1) return undefined;

  const raw = args[index + 1];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid value for --min-mb: ${String(raw)}`);
  }

  return value;
}

async function runScan(root: string, args: string[], logger: TraceLogger): Promise<void> {
  const minMb = parseMinMb(args) ?? 50;
  const classifier = new PathClassifier(logger);
  const scanner = new LocalScanner(classifier, logger);

  console.log('\nAnSysWarden Scan');
  console.log('────────────────────────────────────────');
  console.log(`Root:       ${resolve(root)}`);
  console.log(`Threshold:  ${minMb} MB`);
  console.log('Mode:       READ ONLY');

  const summary = await scanner.scan(root, { minBytes: minMb * 1024 * 1024 });

  console.log('\nCandidates');
  console.log('────────────────────────────────────────');

  if (summary.candidates.length === 0) {
    console.log('No directories were found above the threshold.');
  } else {
    summary.candidates.forEach((candidate, index) => {
      console.log(`${index + 1}. ${candidateLabel(candidate.path)}`);
      console.log(`   Path:           ${candidate.path}`);
      console.log(`   Size:           ${formatBytes(candidate.sizeBytes)}`);
      console.log(`   Classification: ${candidate.classification}`);
      console.log(`   Confidence:     ${Math.round(candidate.confidence * 100)}%`);
      console.log(`   Source:         ${candidate.source}`);
      console.log(`   Reason:         ${candidate.reason}`);
      console.log('');
    });
  }

  console.log('Summary');
  console.log('────────────────────────────────────────');
  console.log(`Files scanned:       ${summary.scannedFiles}`);
  console.log(`Directories scanned: ${summary.scannedDirectories}`);
  console.log(`Skipped entries:     ${summary.skippedEntries}`);
  console.log(`Total measured:      ${formatBytes(summary.totalBytes)}`);
  console.log(`Potentially safe:    ${formatBytes(summary.recoverableBytes)}`);
  console.log('Action:              No files have been deleted.');
  console.log(`Run ID:              ${logger.runId}`);
  console.log(`Trace:                ${logger.logFile}`);
}

const CATEGORY_LABELS: Record<SafetyCategory, string> = {
  datos_usuario: 'Photos, documents and downloads',
  cache_conocida: 'Known caches',
  reglas_deterministas: 'Deterministic rules under attack',
  ambiguedad: 'Ambiguous or misleading names',
  prompt_injection: 'Attempts to give commands to Gemma',
  barrera_sistema: 'AnSysWarden final safety barrier',
};

function humanInterpretation(mode: 'system' | 'model', actual: string, source?: string, reason?: string): string {
  if (actual === 'SKIPPED') {
    return 'Case skipped by the circuit breaker to avoid chained inference after degradation or timeout.';
  }
  const blocked = source === 'fallback' && reason?.includes('Gemma propuso SAFE_CACHE');
  if (mode === 'model' && actual === 'SAFE_CACHE') {
    return 'Gemma was too permissive. This response must NOT be used directly for deletion.';
  }
  if (mode === 'model' && actual === 'ERROR') {
    return 'Gemma did not follow the expected format or exceeded the timeout. This never authorizes deletion.';
  }
  if (blocked) return 'Gemma was wrong, but AnSysWarden blocked it. Nothing would be deleted.';
  if (actual === 'SAFE_CACHE') return 'This is a known regenerable cache. It is accepted only because a local rule authorizes it.';
  if (actual === 'USER_DATA') return 'This is treated as user data and remains protected.';
  if (actual === 'REVIEW_REQUIRED') return 'There is not enough certainty. It is preserved and requires human review.';
  return 'No valid decision was obtained; the case must be reviewed.';
}

async function ensureSafetyAiReady(logger: TraceLogger): Promise<boolean> {
  const ollama = new OllamaClient(undefined, undefined, logger);
  console.log(`\n${paint('AI precheck', ANSI.bold)}`);
  console.log('────────────────────────────────────────────────────');
  console.log(`Host:  ${ollama.getHost()}`);
  console.log(`Model: ${ollama.getModel()}`);

  try {
    const status = await ollama.health();
    const modelPresent = status.models.some((name) => name.startsWith(ollama.getModel()));
    if (!modelPresent) {
      console.log(paint('🔴 Gemma is not available in Ollama.', ANSI.red));
      console.log(`Detected models: ${status.models.length ? status.models.join(', ') : '(none)'}`);
      console.log('Human view: the test cannot evaluate Gemma because the model is not loaded/installed.');
      console.log('Action: run ./ansys ai start and then ./ansys ai test.');
      await logger.error('safety.precheck.model_missing', 'Required model unavailable for the safety suite', {
        model: ollama.getModel(),
        models: status.models,
      });
      process.exitCode = 3;
      return false;
    }

    console.log(paint('🟢 Ollama is responding and Gemma is available.', ANSI.green));
    console.log('Human view: we can now measure the model\'s real behavior.');
    await logger.info('safety.precheck.ok', 'AI precheck passed', {
      model: ollama.getModel(),
      models: status.models,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(paint('🔴 Ollama is not reachable.', ANSI.red));
    console.log(`Technical detail: ${message}`);
    console.log('Human view: Gemma did not fail the tests; it simply never ran.');
    console.log('Action: run ./ansys ai start and confirm with ./ansys ai status.');
    await logger.error('safety.precheck.ollama_unavailable', 'Ollama unavailable before the safety suite', {
      error: message,
      host: ollama.getHost(),
      model: ollama.getModel(),
    });
    process.exitCode = 3;
    return false;
  }
}

async function runSafety(logger: TraceLogger): Promise<void> {
  console.log(`\n${paint('AnSysWarden · AI Safety Tests', ANSI.bold)}`);
  console.log('════════════════════════════════════════════════════');
  console.log('Hybrid view: technical data + human-readable explanation.');
  console.log(`${paint('Main rule', ANSI.cyan)}: Gemma may recommend; only AnSysWarden may authorize SAFE_CACHE.`);

  if (!(await ensureSafetyAiReady(logger))) return;

  const result = await runAiSafetySuite(logger);

  for (let index = 0; index < result.results.length; index += 1) {
    const item = result.results[index];
    const skipped = item.skipped === true || item.actual === 'SKIPPED';
    const ok = item.passed;
    const mode = item.test.mode === 'model' ? 'GEMMA' : 'SYSTEM';
    const modeColor = item.test.mode === 'model' ? ANSI.cyan : ANSI.magenta;
    const expected = item.test.allowed.join(' | ');
    const blocked = item.source === 'fallback' && item.reason?.includes('Gemma propuso SAFE_CACHE');
    const confidence = item.source === 'fallback'
      ? 'N/A — safety decision'
      : item.confidence !== undefined
        ? `${Math.round(item.confidence * 100)}%`
        : 'n/a';
    const statusLabel = skipped ? paint('SKIP', ANSI.yellow) : ok ? paint('PASS', ANSI.green) : paint('FAIL', ANSI.red);

    console.log('\n────────────────────────────────────────────────────');
    console.log(`${statusLabel}  ${paint(item.test.id, ANSI.bold)}  [${paint(mode, modeColor)}]  ${index + 1}/${result.results.length}`);
    console.log(`Case: ${item.test.description}`);
    console.log('');
    console.log(`${paint('TECHNICAL TRACE', ANSI.bold)}`);
    console.log(`├─ INPUT        ${item.test.input}`);
    console.log(`├─ EXPECTED     ${expected}`);
    console.log(`├─ ACTUAL       ${item.actual}`);
    console.log(`├─ CONFIDENCE   ${confidence}`);
    console.log(`├─ SOURCE       ${item.source ?? 'n/a'}`);
    if (item.reason) console.log(`├─ REASON       ${item.reason}`);
    if (item.error) console.log(`├─ ERROR        ${item.error}`);
    if (blocked) console.log(`├─ POLICY       ${paint('SAFE_CACHE BLOCKED', ANSI.yellow)}`);
    console.log(`└─ DURATION     ${item.durationMs} ms`);

    console.log('');
    console.log(`${paint('HUMAN VIEW', ANSI.bold)}`);
    if (skipped) {
      console.log('⏭️ AnSysWarden did not run Gemma again after the timeout.');
      console.log('🧯 The circuit breaker avoids another long wait and reduces RAM/thermal pressure.');
    } else if (item.test.mode === 'model') {
      console.log(`🤖 Gemma says: ${item.actual}${item.confidence !== undefined ? ` with ${Math.round(item.confidence * 100)}% confidence` : ''}.`);
      console.log(`💬 In other words: ${item.reason ?? item.error ?? 'no explanation available.'}`);
      console.log(`🧪 Here we are measuring ${paint('Gemma quality', ANSI.cyan)}, not AnSysWarden's final decision.`);
    } else if (blocked) {
      console.log('🤖 Gemma tried to say: SAFE_CACHE.');
      console.log(`🛡️ AnSysWarden said: ${paint('NO', ANSI.yellow)}. That decision is not authorized by a local rule.`);
    } else {
      console.log(`🛡️ AnSysWarden decided: ${item.actual}.`);
    }
    console.log(`${skipped ? '⏭️' : ok ? '✅' : '⚠️'} Meaning: ${humanInterpretation(item.test.mode, item.actual, item.source, item.reason)}`);
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(paint('TWO DIFFERENT RESULTS', ANSI.bold));
  const evaluatedModelCases = result.modelPassed + result.modelFailed;
  console.log(`${result.modelFailed === 0 ? '🟢' : '🟡'} Gemma quality: ${result.modelPassed}/${evaluatedModelCases} evaluated correctly${result.modelSkipped ? ` · ${result.modelSkipped} skipped` : ''}`);
  console.log(`${result.systemFailed === 0 ? '🟢' : '🔴'} AnSysWarden safety: ${result.systemPassed}/${result.systemPassed + result.systemFailed} safe decisions`);
  console.log('');
  if (result.modelFailed > 0 && result.systemFailed === 0) {
    console.log('Human view: Gemma had technical failures, but AnSysWarden guardrails prevented them from becoming dangerous decisions.');
  }
  if (result.modelSkipped > 0) {
    console.log(`Human view: ${result.modelSkipped} case(s) were not executed after the circuit breaker opened.`);
  }

  console.log('\n' + paint('SUMMARY BY RISK TYPE', ANSI.bold));
  const categories = Object.keys(CATEGORY_LABELS) as SafetyCategory[];
  for (const category of categories) {
    const items = result.results.filter((item) => item.test.category === category);
    if (items.length === 0) continue;
    const evaluated = items.filter((item) => !item.skipped);
    const passed = evaluated.filter((item) => item.passed).length;
    const skippedCount = items.length - evaluated.length;
    const safe = evaluated.length > 0 && passed === evaluated.length;
    console.log(`${safe ? '🟢' : '🟡'} ${CATEGORY_LABELS[category]}: ${passed}/${evaluated.length} evaluated${skippedCount ? ` · ${skippedCount} skipped` : ''}`);
  }

  console.log('\n════════════════════════════════════════════════════');
  if (result.systemFailed === 0) {
    console.log(paint('🟢 EFFECTIVE SAFETY: all system guardrail tests passed', ANSI.green));
  } else {
    console.log(paint(`🔴 EFFECTIVE SAFETY: ${result.systemFailed} system failure(s)`, ANSI.red));
  }
  if (result.modelFailed > 0) {
    console.log(paint(`🟡 GEMMA QUALITY: ${result.modelFailed} technical failure(s) among evaluated cases`, ANSI.yellow));
  }
  if (result.modelSkipped > 0) {
    console.log(paint(`🟡 AI CIRCUIT BREAKER: ${result.modelSkipped} case(s) skipped after timeout`, ANSI.yellow));
  }
  console.log(`\nFull JSONL trace: ${logger.logFile}`);

  if (result.systemFailed > 0) process.exitCode = 2;
}

async function main(): Promise<void> {
  const [, , command, rawPath, ...rest] = process.argv;
  const logger = new TraceLogger();

  await logger.info('run.start', 'Run started', {
    command: command ?? null,
    argv: process.argv.slice(2),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });

  if (command === 'doctor') {
    await runDoctor(logger);
    return;
  }

  if (command === 'classify' && rawPath) {
    const classifier = new PathClassifier(logger);
    const result = await classifier.classify(resolve(rawPath));
    printResult(result, logger);
    return;
  }

  if (command === 'scan' && rawPath) {
    await runScan(rawPath, rest, logger);
    return;
  }

  if (command === 'test' && rawPath === 'safety') {
    await runSafety(logger);
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch(async (error: unknown) => {
  const logger = new TraceLogger();
  const message = error instanceof Error ? error.message : String(error);
  await logger.error('run.fatal', 'Unhandled fatal error', { error: message });
  console.error('[AnSysWarden] Error:', error);
  console.error(`[AnSysWarden] Trace: ${logger.logFile}`);
  process.exitCode = 1;
});
