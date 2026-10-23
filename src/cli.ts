import { resolve } from 'node:path';
import { PathClassifier } from './ai/classifier';
import { OllamaClient } from './ai/ollama-client';
import { TraceLogger } from './observability/logger';
import { LocalScanner, candidateLabel, formatBytes } from './scanner/scanner';
import { runAiSafetySuite } from './tests/ai-safety';

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
};

function color(text: string, code: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `${code}${text}${ANSI.reset}`;
}

function classificationColor(value: string): string {
  if (value === 'SAFE_CACHE') return color(value, ANSI.green);
  if (value === 'USER_DATA') return color(value, ANSI.blue);
  if (value === 'REVIEW_REQUIRED') return color(value, ANSI.yellow);
  if (value === 'ERROR') return color(value, ANSI.red);
  return value;
}

function usage(): void {
  console.log('Uso:');
  console.log('  npx tsx src/cli.ts doctor');
  console.log('  npx tsx src/cli.ts classify <ruta>');
  console.log('  npx tsx src/cli.ts scan <ruta> [--min-mb N]');
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
      'Comprobando Ollama local',
      () => ollama.health(),
      { host: ollama.getHost(), model: ollama.getModel() },
    );

    console.log('Status:      OK');
    console.log(`Models:      ${status.models.length ? status.models.join(', ') : '(ninguno)'}`);
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
    throw new Error(`Valor inválido para --min-mb: ${String(raw)}`);
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
    console.log('No se encontraron directorios por encima del umbral.');
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
  console.log(`Trace:               ${logger.logFile}`);
}

async function runSafety(logger: TraceLogger): Promise<void> {
  console.log(`\n${color('AnSysWarden · AI Safety Tests', ANSI.bold)}`);
  console.log('════════════════════════════════════════════════════');
  console.log(`${color('Objetivo', ANSI.cyan)}  Gemma puede opinar; AnSysWarden decide.`);
  console.log(`${color('Política', ANSI.cyan)}  SAFE_CACHE solo se autoriza mediante regla local explícita.`);
  console.log(`${color('Modo', ANSI.cyan)}      READ ONLY`);

  const result = await runAiSafetySuite(logger);

  console.log(`\n${color('TRACE VISUAL', ANSI.bold)}`);
  console.log('════════════════════════════════════════════════════');

  for (const item of result.results) {
    const status = item.passed
      ? color('PASS', ANSI.green)
      : color('FAIL', ANSI.red);
    const mode = item.test.mode === 'system'
      ? color('SYSTEM', ANSI.magenta)
      : color('GEMMA', ANSI.cyan);
    const expected = item.test.allowed.map(classificationColor).join(' | ');
    const actual = classificationColor(item.actual);

    console.log(`\n${status}  ${color(item.test.id, ANSI.bold)}  [${mode}]`);
    console.log(`│ ${item.test.description}`);
    console.log(`│`);
    console.log(`├─ ${color('INPUT', ANSI.gray)}      ${item.test.input}`);
    console.log(`├─ ${color('EXPECTED', ANSI.gray)}   ${expected}`);

    if (item.test.mode === 'model') {
      console.log(`├─ ${color('GEMMA', ANSI.cyan)}      ${actual}${item.confidence !== undefined ? ` · ${Math.round(item.confidence * 100)}%` : ''}`);
      console.log(`│  ${color('reason', ANSI.dim)}     ${item.reason ?? item.error ?? '(sin detalle)'}`);
      console.log(`└─ ${color('VERDICT', item.passed ? ANSI.green : ANSI.red)}    ${item.passed ? 'La respuesta del modelo respeta la política del test.' : 'La respuesta del modelo viola la política del test.'}`);
    } else {
      const source = item.source ?? 'unknown';
      const policyBlocked = source === 'fallback' && item.reason?.includes('Gemma propuso SAFE_CACHE');
      console.log(`├─ ${color('SYSTEM', ANSI.magenta)}     ${actual}${item.confidence !== undefined ? ` · ${Math.round(item.confidence * 100)}%` : ''}`);
      console.log(`├─ ${color('SOURCE', ANSI.gray)}     ${source}`);
      if (policyBlocked) {
        console.log(`├─ ${color('POLICY', ANSI.yellow)}     ${color('BLOCKED', ANSI.yellow)} · Gemma intentó elevar a SAFE_CACHE y AnSysWarden lo degradó.`);
      }
      console.log(`│  ${color('reason', ANSI.dim)}     ${item.reason ?? item.error ?? '(sin detalle)'}`);
      console.log(`└─ ${color('VERDICT', item.passed ? ANSI.green : ANSI.red)}    ${item.passed ? 'La decisión efectiva del sistema es segura.' : 'La decisión efectiva del sistema NO es segura.'}`);
    }

    console.log(`   ${color('duration', ANSI.dim)} ${item.durationMs} ms`);
  }

  console.log(`\n${color('SUMMARY', ANSI.bold)}`);
  console.log('════════════════════════════════════════════════════');
  console.log(`${color('Passed', ANSI.green)}   ${result.passed}`);
  console.log(`${color('Failed', result.failed === 0 ? ANSI.green : ANSI.red)}   ${result.failed}`);
  console.log(`Run ID   ${logger.runId}`);
  console.log(`Trace    ${logger.logFile}`);
  console.log(`\nLeyenda: ${color('verde=seguro', ANSI.green)} · ${color('amarillo=revisión/bloqueo', ANSI.yellow)} · ${color('rojo=fallo', ANSI.red)} · ${color('cian=Gemma', ANSI.cyan)} · ${color('magenta=AnSysWarden', ANSI.magenta)}`);

  if (result.failed > 0) {
    process.exitCode = 2;
  }
}

async function main(): Promise<void> {
  const [, , command, rawPath, ...rest] = process.argv;
  const logger = new TraceLogger();

  await logger.info('run.start', 'Inicio de ejecución', {
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
  await logger.error('run.fatal', 'Error fatal no controlado', { error: message });
  console.error('[AnSysWarden] Error:', error);
  console.error(`[AnSysWarden] Trace: ${logger.logFile}`);
  process.exitCode = 1;
});
