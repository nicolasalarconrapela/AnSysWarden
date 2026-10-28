import { BackendStorage } from '../backend/storage';
import { isScanDocument, type ScanDocument } from '../backend/types';
import { DustScanner } from '../dust/dust-scanner';
import { ScanCache } from '../infrastructure/persistence/scan-cache';
import { buildReclaimReport, formatBytes, type ReclaimCandidate } from './reclaim-engine';

function usage(): never {
  console.log('AnSysWarden · Reclaim');
  console.log('────────────────────────────────────────');
  console.log('Uso:');
  console.log('  ./ansys-reclaim scan <ruta> [--depth N] [--min-size SIZE] [--max N]');
  console.log('  ./ansys-reclaim latest [--max N]');
  console.log('  ./ansys-reclaim show <scan-id> [--max N]');
  console.log(`  ./ansys-reclaim json '<scan-json>' [--max N]`);
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readPositiveInt(args: string[], name: string, fallback: number): number {
  const raw = readOption(args, name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 1000) {
    throw new Error(`${name} debe ser un entero entre 1 y 1000.`);
  }
  return value;
}

function parseScanJson(raw: string): ScanDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`JSON inválido: ${reason}`);
  }

  if (!isScanDocument(parsed)) {
    throw new Error('El JSON no cumple el contrato ansyswarden.scan.v1. No se analizará.');
  }

  return parsed;
}

function printGroup(title: string, rows: ReclaimCandidate[], max: number): void {
  console.log(`\n${title} (${Math.min(rows.length, max)}/${rows.length})`);
  console.log('────────────────────────────────────────');
  if (rows.length === 0) {
    console.log('  Ninguno.');
    return;
  }

  for (const row of rows.slice(0, max)) {
    console.log(`${formatBytes(row.sizeBytes).padStart(10)}  ${row.path}`);
    console.log(`            ${row.reason}`);
  }
}

function printReport(scanId: string, report: ReturnType<typeof buildReclaimReport>, max: number): void {
  console.log('\nAnSysWarden · Propuestas de espacio');
  console.log('════════════════════════════════════════');
  console.log(`Scan ID: ${scanId}`);
  console.log(`Entradas JSON: ${report.totalEntries}`);
  console.log(`Entradas analizadas: ${report.analyzedEntries}`);
  console.log(`Recuperable confirmado: ${formatBytes(report.confirmedRecoverableBytes)}`);
  console.log(`Propuestas: ${report.deleteCandidates.length} eliminar · ${report.reviewCandidates.length} revisar · ${report.protectCandidates.length} proteger`);
  console.log('Seguridad: esta orden NO borra archivos. Solo reglas locales deterministas pueden proponer ELIMINAR.');

  if (report.rootFallbackUsed) {
    console.log('Aviso: el escaneo no contiene hijos utilizables; se analiza la raíz como REVISAR/PROTEGER/ELIMINAR según reglas.');
    console.log('Para propuestas más precisas, genera un escaneo con mayor profundidad o menor --min-size.');
  } else if (report.totalEntries <= 3) {
    console.log('Aviso: el escaneo contiene muy pocas entradas; las propuestas pueden ser demasiado generales.');
  }

  printGroup('ELIMINAR', report.deleteCandidates, max);
  printGroup('REVISAR', report.reviewCandidates, max);
  printGroup('PROTEGER', report.protectCandidates, max);
}

async function findScanHere(storage: BackendStorage, cache: ScanCache, id: string): Promise<ScanDocument | null> {
  const original = await storage.getScan(id);
  if (original) return original;

  const cached = await cache.get(id);
  return cached?.scan ?? null;
}

async function findLatestScanHere(storage: BackendStorage, cache: ScanCache): Promise<ScanDocument | null> {
  const [originals, copies] = await Promise.all([storage.listScans(), cache.list()]);
  const candidates = [
    ...originals.map((scan) => ({ id: scan.id, createdAt: scan.createdAt })),
    ...copies.map((scan) => ({ id: scan.scanId, createdAt: scan.createdAt })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  for (const candidate of candidates) {
    const scan = await findScanHere(storage, cache, candidate.id);
    if (scan) return scan;
  }

  return null;
}

async function run(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const storage = new BackendStorage();
  const cache = new ScanCache();
  const max = readPositiveInt(args, '--max', 10);

  if (command === 'scan') {
    const inputPath = args[0];
    if (!inputPath || inputPath.startsWith('--')) usage();

    const depthRaw = readOption(args, '--depth');
    const depth = depthRaw === undefined ? undefined : Number.parseInt(depthRaw, 10);
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 1 || depth > 32)) {
      throw new Error('--depth debe estar entre 1 y 32.');
    }

    const minSize = readOption(args, '--min-size');
    const scanner = new DustScanner(storage);

    console.log('\nAnSysWarden · Recuperar espacio');
    console.log('────────────────────────────────────────');
    console.log(`Escaneando: ${inputPath}`);
    console.log('Modo: solo lectura · no se eliminará ningún archivo');

    const result = await scanner.scan(inputPath, { depth, minSize });
    const report = buildReclaimReport(result.scan);
    printReport(result.scan.id, report, max);
    return;
  }

  if (command === 'latest') {
    const scan = await findLatestScanHere(storage, cache);
    if (!scan) throw new Error('No hay ningún escaneo disponible en este dispositivo.');
    printReport(scan.id, buildReclaimReport(scan), max);
    return;
  }

  if (command === 'show') {
    const id = args[0];
    if (!id || id.startsWith('--')) usage();
    const scan = await findScanHere(storage, cache, id);
    if (!scan) throw new Error(`No existe el escaneo ${id} en este dispositivo.`);
    printReport(scan.id, buildReclaimReport(scan), max);
    return;
  }

  if (command === 'json') {
    const raw = args[0];
    if (!raw || raw.startsWith('--')) usage();
    const scan = parseScanJson(raw);
    console.log('AnSysWarden · JSON directo');
    console.log('────────────────────────────────────────');
    console.log(`Origen: ${scan.origin?.deviceRole ?? 'desconocido'} · ${scan.origin?.platform ?? scan.computer}`);
    console.log(`Ruta: ${scan.origin?.rootPath ?? '-'}`);
    console.log('Persistencia: no se guarda; solo se analiza en memoria.');
    printReport(scan.id, buildReclaimReport(scan), max);
    return;
  }

  usage();
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Reclaim] ${message}`);
  process.exitCode = 1;
});
