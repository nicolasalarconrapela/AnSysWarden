import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isScanDocument, type ScanDocument } from '../backend/types';
import { buildReclaimReport } from '../reclaim/reclaim-engine';
import { buildPcTreeHtml } from './tree-html';

function usage(): never {
  console.log('AnSysWarden · PC Tree Viewer');
  console.log('────────────────────────────────────────');
  console.log('Uso:');
  console.log('  ./ansys pc view <scan.json> [--out archivo.html]');
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function loadScan(filePath: string): Promise<ScanDocument> {
  const raw = await readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`JSON inválido: ${reason}`);
  }

  if (!isScanDocument(parsed)) {
    throw new Error('El archivo no cumple el contrato ansyswarden.scan.v1.');
  }

  return parsed;
}

async function main(): Promise<void> {
  const [, , command, input, ...rest] = process.argv;
  if (command !== 'view' || !input || input.startsWith('--')) usage();

  const inputPath = resolve(input);
  const outputPath = resolve(readOption(rest, '--out') ?? 'ansyswarden-tree.html');
  const scan = await loadScan(inputPath);
  const report = buildReclaimReport(scan);
  const html = buildPcTreeHtml(scan, report);

  await writeFile(outputPath, html, 'utf8');

  console.log('AnSysWarden · Vista HTML generada');
  console.log('────────────────────────────────────────');
  console.log(`Entrada: ${inputPath}`);
  console.log(`Salida:  ${outputPath}`);
  console.log(`Entradas: ${scan.entries.length}`);
  console.log('Modo: solo lectura · el HTML no modifica archivos.');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden PC] ${message}`);
  process.exitCode = 1;
});
