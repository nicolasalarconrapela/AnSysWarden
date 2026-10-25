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
  reglas_deterministas: 'Reglas deterministas bajo ataque',
  ambiguedad: 'Nombres dudosos o engañosos',
  prompt_injection: 'Intentos de dar órdenes a Gemma',
  barrera_sistema: 'Bloqueo final de AnSysWarden',
};

function humanInterpretation(mode: 'system' | 'model', actual: string, source?: string, reason?: string): string {
  if (actual === 'SKIPPED') {
    return 'Caso omitido por el cortacircuitos para evitar encadenar inferencias tras degradación o timeout.';
  }
  const blocked = source === 'fallback' && reason?.includes('Gemma propuso SAFE_CACHE');
  if (mode === 'model' && actual === 'SAFE_CACHE') {
    return 'Gemma ha sido demasiado permisivo. Esta respuesta NO debe usarse directamente para borrar.';
  }
  if (mode === 'model' && actual === 'ERROR') {
    return 'Gemma no respetó el formato esperado o superó el límite de tiempo. Esto no autoriza ningún borrado.';
  }
  if (blocked) return 'Gemma se equivocó, pero AnSysWarden lo bloqueó. No se borraría nada.';
  if (actual === 'SAFE_CACHE') return 'Es una caché conocida y regenerable. Solo se acepta porque existe una regla local.';
  if (actual === 'USER_DATA') return 'Se considera información del usuario y queda protegida.';
  if (actual === 'REVIEW_REQUIRED') return 'No hay suficiente certeza. Se conserva y requiere revisión.';
  return 'No se obtuvo una decisión válida; el caso debe revisarse.';
}

async function ensureSafetyAiReady(logger: TraceLogger): Promise<boolean> {
  const ollama = new OllamaClient(undefined, undefined, logger);
  console.log(`\n${paint('Precheck de IA', ANSI.bold)}`);
  console.log('────────────────────────────────────────────────────');
  console.log(`Host:   ${ollama.getHost()}`);
  console.log(`Modelo: ${ollama.getModel()}`);

  try {
    const status = await ollama.health();
    const modelPresent = status.models.some((name) => name.startsWith(ollama.getModel()));
    if (!modelPresent) {
      console.log(paint('🔴 Gemma no está disponible en Ollama.', ANSI.red));
      console.log(`Modelos detectados: ${status.models.length ? status.models.join(', ') : '(ninguno)'}`);
      console.log('En humano: el test no puede evaluar a Gemma porque el modelo no está cargado/instalado.');
      console.log('Acción: ejecuta ./ansys ai start y después ./ansys ai test.');
      await logger.error('safety.precheck.model_missing', 'Modelo requerido no disponible para la batería de seguridad', {
        model: ollama.getModel(),
        models: status.models,
      });
      process.exitCode = 3;
      return false;
    }

    console.log(paint('🟢 Ollama responde y Gemma está disponible.', ANSI.green));
    console.log('En humano: ahora sí podemos medir el comportamiento real del modelo.');
    await logger.info('safety.precheck.ok', 'Precheck de IA correcto', {
      model: ollama.getModel(),
      models: status.models,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(paint('🔴 Ollama no está accesible.', ANSI.red));
    console.log(`Detalle técnico: ${message}`);
    console.log('En humano: Gemma no ha fallado los tests; simplemente no llegó a ejecutarse.');
    console.log('Acción: ejecuta ./ansys ai start y confirma con ./ansys ai status.');
    await logger.error('safety.precheck.ollama_unavailable', 'Ollama no accesible antes de la batería de seguridad', {
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
  console.log('Vista híbrida: datos técnicos + explicación humana.');
  console.log(`${paint('Regla principal', ANSI.cyan)}: Gemma puede recomendar; solo AnSysWarden puede autorizar SAFE_CACHE.`);

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
      ? 'N/A — decisión de seguridad'
      : item.confidence !== undefined
        ? `${Math.round(item.confidence * 100)}%`
        : 'n/a';
    const statusLabel = skipped ? paint('SKIP', ANSI.yellow) : ok ? paint('PASS', ANSI.green) : paint('FAIL', ANSI.red);

    console.log('\n────────────────────────────────────────────────────');
    console.log(`${statusLabel}  ${paint(item.test.id, ANSI.bold)}  [${paint(mode, modeColor)}]  ${index + 1}/${result.results.length}`);
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
    if (skipped) {
      console.log('⏭️ AnSysWarden no volvió a ejecutar Gemma después del timeout.');
      console.log('🧯 El cortacircuitos evita otra espera larga y reduce presión de RAM/temperatura.');
    } else if (item.test.mode === 'model') {
      console.log(`🤖 Gemma dice: ${item.actual}${item.confidence !== undefined ? ` con ${Math.round(item.confidence * 100)}% de confianza` : ''}.`);
      console.log(`💬 En otras palabras: ${item.reason ?? item.error ?? 'sin explicación disponible.'}`);
      console.log(`🧪 Estamos midiendo aquí la ${paint('calidad de Gemma', ANSI.cyan)}, no la decisión final de AnSysWarden.`);
    } else if (blocked) {
      console.log('🤖 Gemma quiso decir: SAFE_CACHE.');
      console.log(`🛡️ AnSysWarden dijo: ${paint('NO', ANSI.yellow)}. Esa decisión no está autorizada por una regla local.`);
    } else {
      console.log(`🛡️ AnSysWarden decidió: ${item.actual}.`);
    }
    console.log(`${skipped ? '⏭️' : ok ? '✅' : '⚠️'} Qué significa: ${humanInterpretation(item.test.mode, item.actual, item.source, item.reason)}`);
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(paint('DOS RESULTADOS DIFERENTES', ANSI.bold));
  const evaluatedModelCases = result.modelPassed + result.modelFailed;
  console.log(`${result.modelFailed === 0 ? '🟢' : '🟡'} Calidad de Gemma: ${result.modelPassed}/${evaluatedModelCases} evaluadas correctamente${result.modelSkipped ? ` · ${result.modelSkipped} omitida(s)` : ''}`);
  console.log(`${result.systemFailed === 0 ? '🟢' : '🔴'} Seguridad de AnSysWarden: ${result.systemPassed}/${result.systemPassed + result.systemFailed} decisiones seguras`);
  console.log('');
  if (result.modelFailed > 0 && result.systemFailed === 0) {
    console.log('En humano: Gemma ha tenido fallos técnicos, pero las barreras de AnSysWarden han evitado que se conviertan en decisiones peligrosas.');
  }
  if (result.modelSkipped > 0) {
    console.log(`En humano: ${result.modelSkipped} caso(s) no se ejecutaron después de abrir el cortacircuitos.`);
  }

  console.log('\n' + paint('RESUMEN POR TIPO DE RIESGO', ANSI.bold));
  const categories = Object.keys(CATEGORY_LABELS) as SafetyCategory[];
  for (const category of categories) {
    const items = result.results.filter((item) => item.test.category === category);
    if (items.length === 0) continue;
    const evaluated = items.filter((item) => !item.skipped);
    const passed = evaluated.filter((item) => item.passed).length;
    const skippedCount = items.length - evaluated.length;
    const safe = evaluated.length > 0 && passed === evaluated.length;
    console.log(`${safe ? '🟢' : '🟡'} ${CATEGORY_LABELS[category]}: ${passed}/${evaluated.length} evaluadas${skippedCount ? ` · ${skippedCount} omitida(s)` : ''}`);
  }

  console.log('\n════════════════════════════════════════════════════');
  if (result.systemFailed === 0) {
    console.log(paint('🟢 SEGURIDAD EFECTIVA: las barreras del sistema han pasado todas sus pruebas', ANSI.green));
  } else {
    console.log(paint(`🔴 SEGURIDAD EFECTIVA: ${result.systemFailed} fallo(s) del sistema`, ANSI.red));
  }
  if (result.modelFailed > 0) {
    console.log(paint(`🟡 CALIDAD DE GEMMA: ${result.modelFailed} fallo(s) técnico(s) entre los casos evaluados`, ANSI.yellow));
  }
  if (result.modelSkipped > 0) {
    console.log(paint(`🟡 CORTACIRCUITOS IA: ${result.modelSkipped} caso(s) omitidos para evitar nuevas inferencias tras timeout`, ANSI.yellow));
  }
  console.log(`\nTraza JSONL completa: ${logger.logFile}`);

  if (result.systemFailed > 0) process.exitCode = 2;
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
