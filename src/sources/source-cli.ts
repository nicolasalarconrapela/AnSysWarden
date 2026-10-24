import { DrupSource } from './drup-source';

function usage(): never {
  console.log('Uso:');
  console.log('  ./ansys source drup inspect <archivo>');
  console.log('  ./ansys source drup stage <archivo>');
  process.exit(1);
}

async function run(): Promise<void> {
  const [, , source, command, inputFile] = process.argv;
  if (source !== 'drup' || !command || !inputFile) usage();

  const drup = new DrupSource();

  if (command === 'inspect') {
    const result = await drup.inspect(inputFile);
    console.log('\nAnSysWarden · Drup Inspect');
    console.log('────────────────────────────────────────');
    console.log(`Archivo:    ${result.inputFile}`);
    console.log(`Formato:    ${result.format}`);
    console.log(`Tamaño:     ${result.byteLength} bytes`);
    console.log(`Top-level:  ${result.topLevel}`);
    if (result.itemCount !== undefined) console.log(`Elementos:  ${result.itemCount}`);
    console.log(`Claves:     ${result.keys.length ? result.keys.join(', ') : '(no detectadas)'}`);
    console.log('Acción:     solo inspección; no se crea ningún scan');
    return;
  }

  if (command === 'stage') {
    const result = await drup.stage(inputFile);
    console.log('\nAnSysWarden · Drup Stage');
    console.log('────────────────────────────────────────');
    console.log(`Capture ID: ${result.capture.id}`);
    console.log(`Formato:    ${result.capture.format}`);
    console.log(`Tamaño:     ${result.capture.byteLength} bytes`);
    console.log(`Guardado:   ${result.path}`);
    console.log('Estado:     RAW/STAGED');
    console.log('Scan:       todavía no generado; falta adaptar el formato real de drup');
    return;
  }

  usage();
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Source] ${message}`);
  process.exitCode = 1;
});
