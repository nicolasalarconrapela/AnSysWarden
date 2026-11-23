import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { installDust } from './dust-installer';
import { DustScanner } from './dust-scanner';
import { CreateInventorySnapshot } from './inventory-snapshot';
import { parseDustCaptureArguments } from './scan-options';
import { writeNativeTreeHtml } from '../tree/tree-html';
import { getLanguage } from '../i18n';
import { buildPcTreeHtml } from '../pc/tree-html';

function pick(en: string, es: string): string {
  return getLanguage() === 'es' ? es : en;
}

function printDustHelp(): void {
  const lines = getLanguage() === 'es' ? [
    '',
    'AnSysWarden · DUST · Guía para capturar el disco',
    '════════════════════════════════════════════════════════════',
    '',
    '  ¿QUÉ NECESITAS?',
    '  Guardar TODO el contenido de una carpeta:',
    '    ./ansys dust scan "<ruta>" --no-allocated',
    '  Crear también una página para explorarlo:',
    '    ./ansys dust scan "<ruta>" --no-allocated --html visor.html',
    '  Volver a ver una captura guardada SIN repetir el escaneo:',
    '    ./ansys tree view --latest --out visor.html',
    '',
    '  QUÉ SIGNIFICA CADA PALABRA',
    '    scan       Recorre archivos y guarda un inventario NUEVO.',
    '    inventory  Es otro nombre para el mismo inventario.',
    '    legacy     Usa el resumen ANTIGUO para backend/IA.',
    '    install    Instala el ejecutable Dust externo (red necesaria).',
    '    status     Comprueba el ejecutable Dust externo.',
    '',
    '  OPCIONES DEL INVENTARIO NUEVO (scan / inventory)',
    '    <ruta>             Carpeta raíz; entre comillas si tiene espacios.',
    '    --out PATH         Archivo de datos JSONL de salida.',
    '    --output PATH      Otro nombre de --out.',
    '    --html [PATH]      Crear visor HTML; el nombre es opcional.',
    '    --no-allocated     Omitir medición física de espacio.',
    '    --days N           Umbral de antigüedad (1..36500; 180 por defecto).',
    '    --strict           Marcar error si faltan datos o mediciones pedidas.',
    '',
    '  OPCIONES DEL MODO ANTIGUO (SOLO legacy)',
    '    --legacy           Usar el resumen antiguo, NO inventario completo.',
    '    --full             Más detalle (no garantiza que estén todos).',
    '    --depth N          Máximo de niveles (1..32).',
    '    --min-size SIZE    Umbral de tamaño; ejemplo: 50M.',
    '    --ai-depth N       Profundidad del resumen para IA.',
    '    --ai-max-entries N Número de entradas en el resumen para IA.',
    '    --html [PATH]      Crear HTML del resumen antiguo.',
    '',
    '  NO CONFUNDAS',
    '    ./ansys scan <ruta>       Busca candidatos grandes (básico).',
    '    ./ansys dust scan <ruta>  Guarda un inventario completo.',
    '    ./ansys tree view         Enseña un inventario guardado en HTML.',
    '',
    '  PRECAUCIONES',
    '    Las opciones antiguas --depth, --min-size, --full y --ai-*',
    '    activan automáticamente legacy. No las mezcles con --days,',
    '    --out, --no-allocated o --strict.',
    '    El inventario lee las carpetas; guarda informes locales.',
    '    No elimina archivos y una captura parcial no equivale a disco vacío.',
    '    La medición física puede no estar disponible en tu sistema.',
    '',
    '  Si te pierdes: ./ansys --help',
    '',
  ] : [
    '',
    'AnSysWarden · DUST · Disk inventory guide',
    '════════════════════════════════════════════════════════════',
    '',
    '  WHAT DO YOU NEED?',
    '  Save EVERYTHING under a folder:',
    '    ./ansys dust scan "<path>" --no-allocated',
    '  Also produce a page you can browse:',
    '    ./ansys dust scan "<path>" --no-allocated --html viewer.html',
    '  Revisit a previous snapshot WITHOUT scanning again:',
    '    ./ansys tree view --latest --out viewer.html',
    '',
    '  WHAT EACH COMMAND MEANS',
    '    scan       Walks files and saves a NEW inventory.',
    '    inventory  Another name for the same inventory.',
    '    legacy     Uses the OLD backend/AI summary.',
    '    install    Install external Dust (requires network).',
    '    status     Check the external Dust executable.',
    '',
    '  NEW INVENTORY OPTIONS (scan / inventory)',
    '    <path>             Root folder; quote paths with spaces.',
    '    --out PATH         Destination JSONL data file.',
    '    --output PATH      Another name for --out.',
    '    --html [PATH]      Create HTML viewer; file name optional.',
    '    --no-allocated     Skip allocated-space measurement.',
    '    --days N           Age threshold (1..36500; default 180).',
    '    --strict           Error status for incomplete requested data.',
    '',
    '  OLD MODE OPTIONS (legacy only)',
    '    --legacy           Old summary, NOT a complete inventory.',
    '    --full             More detail (still not exhaustive).',
    '    --depth N          Maximum depth (1..32).',
    '    --min-size SIZE    Minimum size; example: 50M.',
    '    --ai-depth N       AI summary depth.',
    '    --ai-max-entries N Maximum number of entries in AI summary.',
    '    --html [PATH]      Create HTML of the old summary.',
    '',
    '  DO NOT CONFUSE',
    '    ./ansys scan <path>       Finds large candidates (basic).',
    '    ./ansys dust scan <path>  Saves a full inventory.',
    '    ./ansys tree view         Shows saved inventory as HTML.',
    '',
    '  SAFETY',
    '    Old --depth, --min-size, --full and --ai-* options',
    '    automatically select legacy mode. Do not mix them with --days,',
    '    --out, --no-allocated or --strict.',
    '    Scanning reads source files and saves local reports.',
    '    No files are deleted, and partial does not mean empty.',
    '    Allocated-space measurement may be unsupported.',
    '',
    '  Lost? Run ./ansys --help',
    '',
  ];
  for (const line of lines) console.log(line);
}

function usage(): never {
  printDustHelp();
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readOptionalPathOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const next = args[index + 1];
  return !next || next.startsWith('--') ? '' : next;
}

function readIntegerOption(args: string[], name: string): number | undefined {
  const raw = readOption(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(pick(`Invalid value for ${name}: ${raw}`, `Valor inválido para ${name}: ${raw}`));
  }
  return value;
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function startScanProgress(): () => void {
  const startedAt = Date.now();
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;

  if (process.stdout.isTTY) {
    const render = (): void => {
      const elapsed = formatElapsed(Date.now() - startedAt);
      const text = `${frames[frame % frames.length]} ${pick('Scanning with Dust...', 'Escaneando con Dust...')} ${elapsed} · ${pick('process active', 'proceso activo')}`;
      frame += 1;
      process.stdout.write(`\r${text.padEnd(72, ' ')}`);
    };

    render();
    const timer = setInterval(render, 200);
    timer.unref();

    return () => {
      clearInterval(timer);
      const elapsed = formatElapsed(Date.now() - startedAt);
      process.stdout.write(`\r✓ ${pick('Dust finished; preparing a safe AI tree', 'Dust terminó; preparando un árbol IA seguro')} · ${elapsed}${' '.repeat(18)}\n`);
    };
  }

  console.log(`${pick('Status', 'Estado')}:      ${pick('Scanning with Dust...', 'Escaneando con Dust...')}`);
  const timer = setInterval(() => {
    const elapsed = formatElapsed(Date.now() - startedAt);
    console.log(`${pick('Progress', 'Progreso')}:    ${elapsed} ${pick('elapsed · Dust is still running', 'transcurrido · Dust sigue ejecutándose')}`);
  }, 10_000);
  timer.unref();

  return () => {
    clearInterval(timer);
    const elapsed = formatElapsed(Date.now() - startedAt);
    console.log(`${pick('Progress', 'Progreso')}:    ${pick(`Dust finished after ${elapsed}; preparing AI tree`, `Dust terminó tras ${elapsed}; preparando árbol IA`)}`);
  };
}

async function run(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === 'help' || command === '--help' || command === '-h' ||
      args.includes('--help') || args.includes('-h')) {
    printDustHelp();
    return;
  }
  const dust = new DustScanner();

  if (command === 'install') {
    console.log(`\nAnSysWarden · ${pick('Dust Installation', 'Instalación de Dust')}`);
    console.log('────────────────────────────────────────');
    console.log(`${pick('Source', 'Fuente')}:     ${pick('official bootandy/dust release', 'release oficial de bootandy/dust')}`);
    console.log(`${pick('Target', 'Destino')}:     ${pick('local installation managed by AnSysWarden', 'instalación local gestionada por AnSysWarden')}`);
    console.log(`${pick('Security', 'Seguridad')}:   ${pick('mandatory SHA-256 verification', 'verificación SHA-256 obligatoria')}`);

    const result = await installDust();
    console.log(`${pick('Version', 'Versión')}:      ${result.version}`);
    console.log(`${pick('Architecture', 'Arquitectura')}: ${result.architecture}`);
    console.log(`${pick('Binary', 'Binario')}:       ${result.binPath}`);
    console.log(`SHA-256:      ${result.sha256}`);

    const version = await dust.version();
    console.log(`${pick('Verification', 'Verificación')}: ${version}`);
    console.log(`${pick('Status', 'Estado')}:       OK`);
    return;
  }

  if (command === 'status') {
    const bin = dust.getBinary();
    const version = await dust.version();
    console.log('\nAnSysWarden · Dust');
    console.log('────────────────────────────────────────');
    console.log(`${pick('Status', 'Estado')}:  OK`);
    console.log(`${pick('Version', 'Versión')}: ${version || pick('(no version)', '(sin versión)')}`);
    console.log(`${pick('Binary', 'Binario')}:  ${bin.path}`);
    console.log(`${pick('Source', 'Fuente')}:  ${bin.source}`);
    console.log(`${pick('Mode', 'Modo')}:    ${pick('external read-only engine', 'motor externo de solo lectura')}`);
    return;
  }

  if (command === 'inventory' || command === 'scan') {
    const capture = parseDustCaptureArguments(command, args);
    if (capture.mode === 'inventory') {
      console.log('\nAnSysWarden · Dust / Inventario completo');
      console.log('────────────────────────────────────────');
      console.log('Origen: ' + capture.rootPath);
      console.log('Modo: inventario nativo completo; sin limitar profundidad ni tamaño');
      const snapshot = await new CreateInventorySnapshot().execute(capture.rootPath, {
        ...(capture.outputPath === undefined ? {} : { outputPath: capture.outputPath }),
        allocated: capture.allocated,
        ageDays: capture.days,
        activityDays: capture.days,
      });
      const { metadata, age, activity, allocation, manifest, manifestPath, warnings } = snapshot;
      const statusSymbol = manifest.status === 'COMPLETE' ? '✓ [PASS]' : '! [WARN]';
      console.log(statusSymbol + ' Captura: ' + manifest.status);
      console.log('Scan ID: ' + metadata.id);
      console.log('Entradas: ' + metadata.entries + ' · Archivos: ' + metadata.files +
        ' · Carpetas: ' + metadata.directories + ' · Errores: ' + metadata.errors);
      console.log('Tamaño lógico: ' + metadata.sizeBytes + ' bytes');
      console.log('Espacio asignado: ' + manifest.space.allocated +
        (allocation ? ' · ' + allocation.summary.allocatedBytesMeasured + ' bytes medidos' : ''));
      console.log('Índice JSONL: ' + metadata.indexPath);
      console.log('Manifiesto v1: ' + manifestPath);
      console.log('Actividad: ' + activity.outputPath);
      console.log('Antigüedad: ' + age.outputPath);
      if (capture.htmlPath !== null) {
        const htmlPath = await writeNativeTreeHtml({
          metadata,
          indexPath: metadata.indexPath,
          outputPath: resolve(capture.htmlPath || metadata.id + '.html'),
        });
        console.log('Tree HTML: ' + htmlPath);
      }
      warnings.forEach(warning => console.warn('! [WARN] ' + warning));
      console.log('Visualizar: ./ansys tree view --scan-id "' + metadata.id + '"');
      if (capture.strict && (manifest.status !== 'COMPLETE' ||
        manifest.space.allocated === 'PARTIAL' ||
        (capture.allocated && manifest.space.allocated === 'UNAVAILABLE'))) {
        console.error('✗ [FAIL] --strict: captura parcial o medición solicitada no disponible.');
        process.exitCode = 2;
      }
      return;
    }

    // Compatibilidad: no cambiamos el contrato histórico Dust + AI Input.
    console.warn('! [WARN] Modo Dust antiguo: salida resumida y ai-input; usa scan sin --legacy para inventario completo.');
    const inputPath = capture.rootPath;
    const { full, depth, minSize, aiTreeDepth, aiTreeMaxEntries } = capture.legacy;
    const htmlOption = capture.htmlPath;
    console.log(`\nAnSysWarden · ${pick('Dust Scan', 'Escaneo Dust')}`);
    console.log('────────────────────────────────────────');
    console.log(`${pick('Source', 'Fuente')}:      ${inputPath}`);
    console.log(`${pick('Mode', 'Modo')}:        ${full ? pick('FULL · maximum directory detail', 'FULL · máximo detalle de directorios') : pick('normal', 'normal')}`);
    console.log(`${pick('Depth', 'Profundidad')}:       ${depth === undefined ? (full ? '32' : pick('default', 'por defecto')) : String(depth)}`);
    console.log(`${pick('Min size', 'Tamaño mínimo')}:    ${minSize ?? (full ? '0B' : pick('default', 'por defecto'))}`);
    if (full) console.log(`${pick('Full limit', 'Límite full')}: 100000 ${pick('directories · 256 MB JSON safety cap', 'directorios · tope de seguridad JSON 256 MB')}`);
    console.log(`${pick('AI tree', 'Árbol IA')}:     ${pick('depth', 'profundidad')} ${aiTreeDepth ?? 6} · max ${aiTreeMaxEntries ?? 2000} ${pick('visible entries', 'entradas visibles')}`);
    console.log(`${pick('HTML view', 'Vista HTML')}:  ${htmlOption === null ? pick('disabled', 'desactivada') : pick('enabled', 'activada')}`);
    console.log(`${pick('Progress', 'Progreso')}:    ${pick('live elapsed time; Dust does not expose a reliable percentage', 'tiempo transcurrido en vivo; Dust no expone un porcentaje fiable')}`);

    const stopProgress = startScanProgress();
    let result: Awaited<ReturnType<DustScanner['scan']>>;
    try {
      result = await dust.scan(inputPath, { full, depth, minSize, aiTreeDepth, aiTreeMaxEntries });
    } finally {
      stopProgress();
    }

    let htmlPath: string | undefined;
    if (htmlOption !== null) {
      htmlPath = resolve(htmlOption || `${result.scan.id}.html`);
      const html = buildPcTreeHtml(result.scan);
      await writeFile(htmlPath, html, 'utf8');
    }

    const ecosystems = result.aiInput.summary.ecosystems.length > 0
      ? result.aiInput.summary.ecosystems.join(', ')
      : pick('(none detected)', '(ninguno detectado)');
    const languages = result.aiInput.summary.languages.length > 0
      ? result.aiInput.summary.languages.join(', ')
      : pick('(no data)', '(sin datos)');

    console.log('────────────────────────────────────────');
    console.log(`Scan ID:      ${result.scan.id}`);
    console.log(`${pick('Mode', 'Modo')}:         ${result.full ? 'FULL' : 'NORMAL'}`);
    console.log(`${pick('Entries', 'Entradas')}:      ${result.scan.entries.length}`);
    console.log(`${pick('Depth', 'Profundidad')}:        ${result.depth}`);
    console.log(`${pick('Min size', 'Tamaño mínimo')}:     ${result.minSize}`);
    console.log(`${pick('Saved', 'Guardado')}:        ${result.filePath}`);
    console.log(`${pick('AI tree', 'Árbol IA')}:      ${result.aiInputPath}`);
    if (htmlPath) console.log(`HTML:         ${htmlPath}`);
    console.log(`  ${pick('visible', 'visibles')}:    ${result.aiInput.summary.visibleEntries}`);
    console.log(`  ${pick('omitted', 'omitidas')}:    ${result.aiInput.summary.omittedEntries}`);
    console.log(`  local:      ${result.aiInput.summary.resolvedLocally}`);
    console.log(`  ${pick('to Gemma', 'a Gemma')}:   ${result.aiInput.summary.aiCandidates}`);
    console.log(`  ${pick('ecosystems', 'ecosistemas')}: ${ecosystems}`);
    console.log(`  Enry:       ${result.aiInput.summary.enryAvailable ? pick('active', 'activo') : pick('manifest fallback', 'fallback por manifiestos')}`);
    console.log(`  ${pick('languages', 'lenguajes')}:  ${languages}`);
    console.log(`${pick('Status', 'Estado')}:       ${pick('scan + project context + ai-input.v1 persisted on the PC backend', 'escaneo + contexto de proyecto + ai-input.v1 persistidos en el backend del PC')}`);
    return;
  }

  usage();
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Dust] ${message}`);
  process.exitCode = 1;
});
