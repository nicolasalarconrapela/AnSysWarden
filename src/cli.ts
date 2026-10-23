import { resolve } from 'node:path';
import { PathClassifier } from './ai/classifier';
import { OllamaClient } from './ai/ollama-client';
import { TraceLogger } from './observability/logger';
import { LocalScanner, candidateLabel, formatBytes } from './scanner/scanner';

function usage(): void {
  console.log('Uso:');
  console.log('  npx tsx src/cli.ts doctor');
  console.log('  npx tsx src/cli.ts classify <ruta>');
  console.log('  npx tsx src/cli.ts scan <ruta> [--min-mb N]');
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
