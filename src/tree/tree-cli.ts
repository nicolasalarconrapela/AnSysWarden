import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { NativeTreeScanner, type TreeEntryRecord, type TreeIndexRecord, type TreeScanMetadata } from './native-tree-scanner';

function usage(): never {
  console.log('AnSysWarden Tree');
  console.log('Uso:');
  console.log('  ./ansys tree scan <ruta> [--out indice.jsonl]');
  console.log('  ./ansys tree show [ruta] [--depth N] [--files] [--index indice.jsonl]');
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readPositiveInt(args: string[], name: string): number | undefined {
  const raw = readOption(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Valor inválido para ${name}: ${raw}`);
  return value;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

async function loadLatestMetadata(): Promise<TreeScanMetadata> {
  const latestPath = resolve('.ansyswarden', 'tree', 'latest.json');
  const raw = await readFile(latestPath, 'utf8');
  return JSON.parse(raw) as TreeScanMetadata;
}

async function runScan(args: string[]): Promise<void> {
  const inputPath = args[0];
  if (!inputPath || inputPath.startsWith('--')) usage();

  const outputPath = readOption(args, '--out');
  const scanner = new NativeTreeScanner();
  const startedAt = Date.now();

  console.log('\nAnSysWarden · Tree Scan');
  console.log('────────────────────────────────────────');
  console.log(`Ruta:       ${inputPath}`);
  console.log('Modo:       scanner nativo completo');
  console.log('Incluye:    carpetas + archivos + tamaños + fechas + errores');
  console.log('Escritura:  índice JSONL incremental');

  const result = await scanner.scan(inputPath, {
    ...(outputPath ? { outputPath } : {}),
    onProgress: (progress) => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      process.stdout.write(`\rEscaneando... ${progress.entries.toLocaleString('es-ES')} entradas · ${progress.files.toLocaleString('es-ES')} archivos · ${progress.directories.toLocaleString('es-ES')} carpetas · ${elapsed}s   `);
    },
  });

  process.stdout.write('\n');
  console.log('────────────────────────────────────────');
  console.log(`Scan ID:     ${result.id}`);
  console.log(`Entradas:    ${result.entries.toLocaleString('es-ES')}`);
  console.log(`Archivos:    ${result.files.toLocaleString('es-ES')}`);
  console.log(`Carpetas:    ${result.directories.toLocaleString('es-ES')}`);
  console.log(`Symlinks:    ${result.symlinks.toLocaleString('es-ES')}`);
  console.log(`Errores:     ${result.errors.toLocaleString('es-ES')}`);
  console.log(`Tamaño:      ${formatBytes(result.sizeBytes)}`);
  console.log(`Índice:      ${result.indexPath}`);
}

async function runShow(args: string[]): Promise<void> {
  const pathArg = args.find((arg) => !arg.startsWith('--') && arg !== readOption(args, '--depth') && arg !== readOption(args, '--index'));
  const maxDepth = readPositiveInt(args, '--depth') ?? 3;
  const includeFiles = args.includes('--files');
  const metadata = await loadLatestMetadata();
  const indexPath = resolve(readOption(args, '--index') ?? metadata.indexPath);
  const rootFilter = pathArg ? resolve(pathArg) : metadata.rootPath;

  const summaries = new Map<string, number>();
  const entries: TreeEntryRecord[] = [];
  const input = createReadStream(indexPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as TreeIndexRecord;
    if (record.record === 'directory-summary') {
      summaries.set(record.path, record.sizeBytes);
      continue;
    }
    if (record.record !== 'entry') continue;
    if (!record.path.toLowerCase().startsWith(rootFilter.toLowerCase())) continue;
    if (record.depth < 0) continue;
    if (!includeFiles && record.type === 'file') continue;
    entries.push(record);
  }

  const rootEntry = entries.find((entry) => entry.path.toLowerCase() === rootFilter.toLowerCase());
  const baseDepth = rootEntry?.depth ?? Math.min(...entries.map((entry) => entry.depth));
  const visible = entries
    .filter((entry) => entry.depth - baseDepth <= maxDepth)
    .sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      const aSize = a.type === 'directory' ? summaries.get(a.path) ?? 0 : a.sizeBytes;
      const bSize = b.type === 'directory' ? summaries.get(b.path) ?? 0 : b.sizeBytes;
      return bSize - aSize || a.name.localeCompare(b.name);
    });

  console.log('\nAnSysWarden · Tree');
  console.log('────────────────────────────────────────');
  console.log(`Raíz: ${rootFilter}`);
  console.log(`Profundidad: ${maxDepth} · Archivos: ${includeFiles ? 'sí' : 'no'}`);
  console.log('────────────────────────────────────────');

  for (const entry of visible) {
    const relativeDepth = Math.max(0, entry.depth - baseDepth);
    const size = entry.type === 'directory' ? summaries.get(entry.path) ?? 0 : entry.sizeBytes;
    const icon = entry.type === 'directory' ? '📁' : entry.type === 'file' ? '📄' : '↗';
    console.log(`${'  '.repeat(relativeDepth)}${icon} ${formatBytes(size).padStart(10)}  ${entry.name}`);
  }
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (command === 'scan') return runScan(args);
  if (command === 'show') return runShow(args);
  usage();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Tree] ${message}`);
  process.exitCode = 1;
});
