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
  console.log(`Trace:                ${logger.logFile}`);
}

const CATEGORY_LABELS: Record<SafetyCategory, string> = {
  datos_usuario: 'Fotos, documentos y descargas',
  cache_conocida: 'Cachés conocidas',
  ambiguedad: 'Nombres dudosos o engañosos',
  prompt_injection: 'Intentos de dar órdenes a Gemma',
  barrera_sistema: 'Bloqueo final de AnSysWarden',
};

function humanInterpretation(actual: string, source?: string, reason?: string): string {
  const blocked = source === 'fallback' && reason?.includes('Gemma propuso SAFE_CACHE');
  if (blocked) return 'Gemma se equivocó, pero AnSysWarden lo bloqueó. No se borraría nada.';
  if (actual === 'SAFE_CACHE') return 'Es una caché conocida y regenerable. Solo se acepta porque existe una regla local.';
  if (actual === 'USER_DATA') return 'Se considera información del usuario y queda protegida.';
  if (actual === 'REVIEW_REQUIRED') return 'No hay suficiente certeza. Se conserva y requiere revisión.';
  return 'No se obtuvo una decisión válida; el caso debe revisarse.';
}

async function runSafety(logger: TraceLogger): Promise<void> {
  console.log(`\n${paint('AnSysWarden · AI Safety Tests', ANSI.bold)}`);
  console.log('════════════════════════════════════════════════════');
  console.log('Vista híbrida: datos técnicos + explicación humana.');
  console.log(`${paint('Regla principal', ANSI.cyan)}: Gemma puede recomendar; solo AnSysWarden puede autorizar SAFE_CACHE.`);

  const result = await runAiSafetySuite(logger);

  for (let index = 0; index < result.results.length; index += 1) {
    const item = result.results[index];
    const ok = item.passed;
    const mode = item.test.mode === 'model' ? 'GEMMA' : 'SYSTEM';
    const modeColor = item.test.mode === 'model' ? ANSI.cyan : ANSI.magenta;
    const expected = item.test.allowed.join(' | ');
    const confidence = item.confidence !== undefined ? `${Math.round(item.confidence * 100)}%` : 'n/a';
    const blocked = item.source === 'fallback' && item.reason?.includes('Gemma propuso SAFE_CACHE');

    console.log('\n────────────────────────────────────────────────────');
    console.log(`${ok ? paint('PASS', ANSI.green) : paint('FAIL', ANSI.red)}  ${paint(item.test.id, ANSI.bold)}  [${paint(mode, modeColor)}]  ${index + 1}/${result.results.length}`);
    console.log(`Caso: ${item.test.description}`);
    console.log('');
    console.log(`${paint('TRACE TÉCNICA', ANSI.bold)}`);
    console.log(`├─ INPUT        ${item.test.input}`);
    console.log(`├─ EXPECTED     ${expected}`);
    console.log(`├─ ACTUAL       ${item.actual}`);
    console.log(`├─ CONFIDENCE   ${confidence}`);
    console.log(`├─ SOURCE       ${item.source ?? 'n/a'}`);
    if (item.reason) console.log(`├─ REASON       ${item.reason}`);
    if (item.error) console.log(`├─ ERROR        ${item.error}`);
    if (blocked) console.log(`├─ POLICY       ${paint('SAFE_CACHE BLOQUEADO', ANSI.yellow)}`);
    console.log(`└─ DURATION     ${item.durationMs} ms`);

    console.log('');
    console.log(`${paint('EN HUMANO', ANSI.bold)}`);
    if (item.test.mode === 'model') {
      console.log(`🤖 Gemma dice: ${item.actual}${item.confidence !== undefined ? ` con ${Math.round(item.confidence * 100)}% de confianza` : ''}.`);
      console.log(`💬 En otras palabras: ${item.reason ?? item.error ?? 'sin explicación disponible.'}`);
    } else if (blocked) {
      console.log(`🤖 Gemma quiso decir: SAFE_CACHE.`);
      console.log(`🛡️ AnSysWarden dijo: ${paint('NO', ANSI.yellow)}. Esa decisión no está autorizada por una regla local.`);
    } else {
      console.log(`🛡️ AnSysWarden decidió: ${item.actual}.`);
    }
    console.log(`${ok ? '✅' : '⚠️'} Qué significa: ${humanInterpretation(item.actual, item.source, item.reason)}`);
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(paint('RESUMEN POR TIPO DE RIESGO', ANSI.bold));
  const categories = Object.keys(CATEGORY_LABELS) as SafetyCategory[];
  for (const category of categories) {
    const items = result.results.filter((item) => item.test.category === category);
    if (items.length === 0) continue;
    const passed = items.filter((item) => item.passed).length;
    const safe = passed === items.length;
    console.log(`${safe ? '🟢' : '🔴'} ${CATEGORY_LABELS[category]}: ${passed}/${items.length}`);
  }

  console.log('\n════════════════════════════════════════════════════');
  if (result.failed === 0) {
    console.log(paint(`🟢 RESULTADO FINAL: ${result.passed}/${result.results.length} pruebas seguras`, ANSI.green));
    console.log('La batería no ha encontrado ninguna decisión peligrosa que AnSysWarden deje pasar.');
  } else {
    console.log(paint(`🔴 RESULTADO FINAL: ${result.failed} prueba(s) peligrosa(s)`, ANSI.red));
    console.log('Esta versión todavía necesita correcciones de seguridad.');
  }
  console.log(`\nTraza JSONL completa: ${logger.logFile}`);

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
