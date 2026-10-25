import { installDust } from './dust-installer';
import { DustScanner } from './dust-scanner';

function usage(): never {
  console.log('Uso:');
  console.log('  ./ansys dust install');
  console.log('  ./ansys dust status');
  console.log('  ./ansys dust scan <ruta> [--depth N] [--min-size SIZE] [--ai-depth N] [--ai-max-entries N]');
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readIntegerOption(args: string[], name: string): number | undefined {
  const raw = readOption(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Valor inválido para ${name}: ${raw}`);
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
      const text = `${frames[frame % frames.length]} Escaneando con Dust... ${elapsed} · proceso activo`;
      frame += 1;
      process.stdout.write(`\r${text.padEnd(72, ' ')}`);
    };

    render();
    const timer = setInterval(render, 200);
    timer.unref();

    return () => {
      clearInterval(timer);
      const elapsed = formatElapsed(Date.now() - startedAt);
      process.stdout.write(`\r✓ Dust finalizado; preparando árbol seguro para IA · ${elapsed}${' '.repeat(18)}\n`);
    };
  }

  console.log('Estado:     Escaneando con Dust...');
  const timer = setInterval(() => {
    const elapsed = formatElapsed(Date.now() - startedAt);
    console.log(`Progreso:   ${elapsed} transcurridos · Dust sigue activo`);
  }, 10_000);
  timer.unref();

  return () => {
    clearInterval(timer);
    const elapsed = formatElapsed(Date.now() - startedAt);
    console.log(`Progreso:   Dust finalizado tras ${elapsed}; preparando árbol IA`);
  };
}

async function run(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const dust = new DustScanner();

  if (command === 'install') {
    console.log('\nAnSysWarden · Instalación de Dust');
    console.log('────────────────────────────────────────');
    console.log('Origen:    release oficial bootandy/dust');
    console.log('Destino:   instalación local gestionada por AnSysWarden');
    console.log('Seguridad: verificación SHA-256 obligatoria');

    const result = await installDust();
    console.log(`Versión:   ${result.version}`);
    console.log(`Arquitectura: ${result.architecture}`);
    console.log(`Binario:   ${result.binPath}`);
    console.log(`SHA-256:   ${result.sha256}`);

    const version = await dust.version();
    console.log(`Verificación: ${version}`);
    console.log('Estado:    OK');
    return;
  }

  if (command === 'status') {
    const bin = dust.getBinary();
    const version = await dust.version();
    console.log('\nAnSysWarden · Dust');
    console.log('────────────────────────────────────────');
    console.log('Estado:   OK');
    console.log(`Versión:  ${version || '(sin versión)'}`);
    console.log(`Binario:  ${bin.path}`);
    console.log(`Origen:   ${bin.source}`);
    console.log('Modo:     motor externo de solo lectura');
    return;
  }

  if (command === 'scan') {
    const inputPath = args[0];
    if (!inputPath || inputPath.startsWith('--')) usage();

    const depth = readIntegerOption(args, '--depth');
    const aiTreeDepth = readIntegerOption(args, '--ai-depth');
    const aiTreeMaxEntries = readIntegerOption(args, '--ai-max-entries');
    const minSize = readOption(args, '--min-size');

    console.log('\nAnSysWarden · Dust Scan');
    console.log('────────────────────────────────────────');
    console.log(`Origen:     ${inputPath}`);
    console.log(`Profundidad:${depth === undefined ? ' por defecto' : String(depth).padStart(2, ' ')}`);
    console.log(`Tamaño mín: ${minSize ?? 'por defecto'}`);
    console.log(`Árbol IA:   profundidad ${aiTreeDepth ?? 6} · máximo ${aiTreeMaxEntries ?? 2000} entradas visibles`);
    console.log('Progreso:   tiempo vivo; Dust no expone un porcentaje fiable');

    const stopProgress = startScanProgress();
    let result: Awaited<ReturnType<DustScanner['scan']>>;
    try {
      result = await dust.scan(inputPath, { depth, minSize, aiTreeDepth, aiTreeMaxEntries });
    } finally {
      stopProgress();
    }

    console.log('────────────────────────────────────────');
    console.log(`Scan ID:    ${result.scan.id}`);
    console.log(`Entradas:   ${result.scan.entries.length}`);
    console.log(`Profundidad:${String(result.depth).padStart(2, ' ')}`);
    console.log(`Tamaño mín: ${result.minSize}`);
    console.log(`Guardado:   ${result.filePath}`);
    console.log(`Árbol IA:   ${result.aiInputPath}`);
    console.log(`  visibles: ${result.aiInput.summary.visibleEntries}`);
    console.log(`  omitidas: ${result.aiInput.summary.omittedEntries}`);
    console.log(`  locales:  ${result.aiInput.summary.resolvedLocally}`);
    console.log(`  a Gemma:  ${result.aiInput.summary.aiCandidates}`);
    console.log('Estado:     scan completo + ai-input.v1 persistidos en el backend del PC');
    return;
  }

  usage();
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Dust] ${message}`);
  process.exitCode = 1;
});
