import { DustScanner } from './dust-scanner';

function usage(): never {
  console.log('Uso:');
  console.log('  ./ansys dust status');
  console.log('  ./ansys dust scan <ruta> [--depth N] [--min-size SIZE]');
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function run(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const dust = new DustScanner();

  if (command === 'status') {
    const version = await dust.version();
    console.log('\nAnSysWarden · Dust');
    console.log('────────────────────────────────────────');
    console.log(`Estado:   OK`);
    console.log(`Versión:  ${version || '(sin versión)'}`);
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
    const result = await dust.scan(inputPath, { depth, minSize });

    console.log('\nAnSysWarden · Dust Scan');
    console.log('────────────────────────────────────────');
    console.log(`Scan ID:    ${result.scan.id}`);
    console.log(`Origen:     ${inputPath}`);
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
