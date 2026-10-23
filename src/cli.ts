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
  gray: '\u001b[90m',
};

function paint(text: string, code: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `${code}${text}${ANSI.reset}`;
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

function humanMeaning(classification: string): string {
  if (classification === 'SAFE_CACHE') return 'Se reconoce como caché conocida y regenerable.';
  if (classification === 'USER_DATA') return 'Parece información del usuario. Se protege.';
  if (classification === 'REVIEW_REQUIRED') return 'No hay suficiente seguridad. No se autoriza como caché.';
  return 'El test no pudo obtener una decisión válida.';
}

const CATEGORY_LABELS: Record<SafetyCategory, string> = {
  datos_usuario: 'Fotos, documentos y descargas',
  cache_conocida: 'Cachés conocidas',
  ambiguedad: 'Nombres dudosos o engañosos',
  prompt_injection: 'Intentos de dar órdenes a Gemma',
  barrera_sistema: 'Bloqueo final de AnSysWarden',
};

async function runSafety(logger: TraceLogger): Promise<void> {
  console.log(`\n${paint('AnSysWarden · Prueba de seguridad', ANSI.bold)}`);
  console.log('════════════════════════════════════════════');
  console.log('Queremos comprobar una sola cosa:');
  console.log(paint('Gemma nunca puede hacer que AnSysWarden trate datos dudosos como basura segura.', ANSI.cyan));

  const result = await runAiSafetySuite(logger);

  for (let index = 0; index < result.results.length; index += 1) {
    const item = result.results[index];
    const ok = item.passed;
    const number = `${index + 1}/${result.results.length}`;

    console.log('\n────────────────────────────────────────────');
    console.log(`${paint(number, ANSI.gray)}  ${ok ? paint('🟢 SEGURO', ANSI.green) : paint('🔴 PELIGRO', ANSI.red)}`);
    console.log(item.test.description);
    console.log('');
    console.log(`📁 Probamos: ${item.test.input}`);

    if (item.test.mode === 'model') {
      console.log(`🤖 Gemma respondió: ${item.actual}${item.confidence !== undefined ? ` (${Math.round(item.confidence * 100)}%)` : ''}`);
      console.log(`   ${item.reason ?? item.error ?? 'Sin explicación.'}`);
      console.log(`🛡️ Resultado: ${ok ? 'La respuesta de Gemma no pone los datos en riesgo.' : 'Gemma ha dado una respuesta que podría ser peligrosa.'}`);
    } else {
      const policyBlocked = item.source === 'fallback' && item.reason?.includes('Gemma propuso SAFE_CACHE');
      if (policyBlocked) {
        console.log(`🤖 Gemma quiso marcarlo como: ${paint('SAFE_CACHE', ANSI.red)}`);
        console.log(`🛡️ AnSysWarden respondió: ${paint('BLOQUEADO', ANSI.yellow)}`);
        console.log(`✅ Resultado final: ${paint('REVISAR, NO BORRAR', ANSI.green)}`);
      } else {
        console.log(`🛡️ AnSysWarden decidió: ${item.actual}`);
        console.log(`   ${humanMeaning(item.actual)}`);
      }
    }

    if (!ok) {
      console.log(paint('⚠️ ESTE CASO NECESITA CORRECCIÓN.', ANSI.red));
    }
  }

  console.log('\n════════════════════════════════════════════');
  console.log(paint('RESUMEN POR TIPO DE RIESGO', ANSI.bold));
  const categories = Object.keys(CATEGORY_LABELS) as SafetyCategory[];
  for (const category of categories) {
    const items = result.results.filter((item) => item.test.category === category);
    if (items.length === 0) continue;
    const passed = items.filter((item) => item.passed).length;
    const safe = passed === items.length;
    console.log(`${safe ? '🟢' : '🔴'} ${CATEGORY_LABELS[category]}: ${passed}/${items.length} seguras`);
  }

  console.log('\n════════════════════════════════════════════');
  if (result.failed === 0) {
    console.log(paint(`🟢 RESULTADO FINAL: ${result.passed}/${result.results.length} pruebas seguras`, ANSI.green));
    console.log('La versión actual no ha dejado pasar ninguna decisión peligrosa en esta batería.');
  } else {
    console.log(paint(`🔴 RESULTADO FINAL: ${result.failed} prueba(s) peligrosa(s)`, ANSI.red));
    console.log('No debemos considerar segura esta versión todavía.');
  }
  console.log(`\nTraza técnica: ${logger.logFile}`);
  console.log(paint('La traza JSONL queda aparte para diagnóstico técnico/IA.', ANSI.gray));

  if (result.failed > 0) process.exitCode = 2;
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
