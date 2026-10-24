import { installDust } from './dust-installer';
import { DustScanner } from './dust-scanner';

function usage(): never {
  console.log('Uso:');
  console.log('  ./ansys dust install');
  console.log('  ./ansys dust status');
  console.log('  ./ansys dust scan <ruta> [--depth N] [--min-size SIZE]');
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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
      process.stdout.write(`\r✓ Escaneo de Dust finalizado en ${elapsed}${' '.repeat(32)}\n`);
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
    console.log(`Progreso:   finalizado tras ${elapsed}`);
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

    const rawDepth = readOption(args, '--depth');
    const depth = rawDepth === undefined ? undefined : Number(rawDepth);
    if (rawDepth !== undefined && (!Number.isInteger(depth) || (depth ?? 0) < 1)) {
      throw new Error(`Valor inválido para --depth: ${rawDepth}`);
    }

    const minSize = readOption(args, '--min-size');

    console.log('\nAnSysWarden · Dust Scan');
    console.log('────────────────────────────────────────');
    console.log(`Origen:     ${inputPath}`);
    console.log(`Profundidad:${depth === undefined ? ' por defecto' : String(depth).padStart(2, ' ')}`);
    console.log(`Tamaño mín: ${minSize ?? 'por defecto'}`);
    console.log('Progreso:   tiempo vivo; Dust no expone un porcentaje fiable');

    const stopProgress = startScanProgress();
    let result: Awaited<ReturnType<DustScanner['scan']>>;
    try {
      result = await dust.scan(inputPath, { depth, minSize });
    } finally {
      stopProgress();
    }

    console.log('────────────────────────────────────────');
    console.log(`Scan ID:    ${result.scan.id}`);
    console.log(`Entradas:   ${result.scan.entries.length}`);
    console.log(`Profundidad:${String(result.depth).padStart(2, ' ')}`);
    console.log(`Tamaño mín: ${result.minSize}`);
    console.log(`Guardado:   ${result.filePath}`);
    console.log('Estado:     scan.v1 persistido en el backend del PC');
    return;
  }

  usage();
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Dust] ${message}`);
  process.exitCode = 1;
});
