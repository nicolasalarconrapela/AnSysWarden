import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { installDust } from './dust-installer';
import { DustScanner } from './dust-scanner';
import { getLanguage } from '../i18n';
import { buildPcTreeHtml } from '../pc/tree-html';

function pick(en: string, es: string): string {
  return getLanguage() === 'es' ? es : en;
}

function usage(): never {
  console.log(pick('Usage:', 'Uso:'));
  console.log('  ./ansys dust install');
  console.log('  ./ansys dust status');
  console.log(`  ./ansys dust scan <${pick('path', 'ruta')}> [--full] [--depth N] [--min-size SIZE] [--ai-depth N] [--ai-max-entries N] [--html [archivo.html]]`);
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

  if (command === 'scan') {
    const inputPath = args[0];
    if (!inputPath || inputPath.startsWith('--')) usage();

    const full = hasFlag(args, '--full');
    const depth = readIntegerOption(args, '--depth');
    const aiTreeDepth = readIntegerOption(args, '--ai-depth');
    const aiTreeMaxEntries = readIntegerOption(args, '--ai-max-entries');
    const minSize = readOption(args, '--min-size');
    const htmlOption = readOptionalPathOption(args, '--html');

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
