import { readFile } from 'node:fs/promises';
import { BackendStorage } from '../backend/storage';
import { isScanDocument, type ScanDocument, type ScanEntry } from '../backend/types';
import { DustScanner } from '../dust/dust-scanner';
import { ScanCache } from '../infrastructure/persistence/scan-cache';
import { analyzeAmbiguousCandidates, type ReclaimAiResult } from './reclaim-ai';
import { buildReclaimReport, formatBytes, type ReclaimCandidate } from './reclaim-engine';

function usage(): never {
  console.log('AnSysWarden · Reclaim');
  console.log('────────────────────────────────────────');
  console.log('Uso:');
  console.log('  ./ansys-reclaim scan <ruta> [--depth N] [--min-size SIZE] [--max N] [--tree] [--ai] [--ai-max N]');
  console.log('  ./ansys-reclaim latest [--max N] [--tree] [--ai] [--ai-max N]');
  console.log('  ./ansys-reclaim show <scan-id> [--max N] [--tree] [--ai] [--ai-max N]');
  console.log(`  ./ansys-reclaim json '<scan-json>' [--max N] [--flat] [--ai] [--ai-max N]`);
  console.log('  ./ansys-reclaim json <archivo.json> [--max N] [--flat] [--ai] [--ai-max N]');
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
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

async function loadScanJson(input: string): Promise<{ scan: ScanDocument; source: string }> {
  const trimmed = input.trim();
  if (trimmed.startsWith('{')) {
    return { scan: parseScanJson(trimmed), source: 'argumento JSON' };
  }

  let raw: string;
  try {
    raw = await readFile(input, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo leer el archivo JSON ${input}: ${reason}`);
  }

  return { scan: parseScanJson(raw), source: input };
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

function printTree(scan: ScanDocument, report: ReturnType<typeof buildReclaimReport>, max: number): void {
  console.log(`\nÁRBOL (${Math.min(scan.entries.length, max)}/${scan.entries.length})`);
  console.log('────────────────────────────────────────');

  const candidateByPath = new Map<string, ReclaimCandidate>();
  for (const candidate of [
    ...report.deleteCandidates,
    ...report.reviewCandidates,
    ...report.protectCandidates,
  ]) {
    candidateByPath.set(normalizePath(candidate.path), candidate);
  }

  const byId = new Map<string, ScanEntry>();
  const children = new Map<string, ScanEntry[]>();
  const roots: ScanEntry[] = [];

  for (const entry of scan.entries) {
    if (entry.entryId) byId.set(entry.entryId, entry);
  }

  for (const entry of scan.entries) {
    if (entry.parentId && byId.has(entry.parentId)) {
      const siblings = children.get(entry.parentId) ?? [];
      siblings.push(entry);
      children.set(entry.parentId, siblings);
    } else {
      roots.push(entry);
    }
  }

  const sortBySize = (a: ScanEntry, b: ScanEntry): number => b.sizeBytes - a.sizeBytes;
  roots.sort(sortBySize);
  for (const siblings of children.values()) siblings.sort(sortBySize);

  let printed = 0;
  const render = (entry: ScanEntry, prefix: string, last: boolean, isRoot: boolean): void => {
    if (printed >= max) return;
    printed += 1;

    const candidate = candidateByPath.get(normalizePath(entry.path));
    const decision = candidate ? formatDecision(candidate.action) : 'RAÍZ';
    const branch = isRoot ? '' : `${prefix}${last ? '└── ' : '├── '}`;
    console.log(`${branch}${displayName(entry.path)} · ${formatBytes(entry.sizeBytes)} · ${decision}`);

    if (!entry.entryId) return;
    const directChildren = children.get(entry.entryId) ?? [];
    const childPrefix = isRoot ? '' : `${prefix}${last ? '    ' : '│   '}`;

    for (let index = 0; index < directChildren.length; index += 1) {
      if (printed >= max) break;
      render(directChildren[index], childPrefix, index === directChildren.length - 1, false);
    }
  };

  for (let index = 0; index < roots.length; index += 1) {
    if (printed >= max) break;
    render(roots[index], '', index === roots.length - 1, true);
  }

  if (scan.entries.length > printed) {
    console.log(`… ${scan.entries.length - printed} entradas omitidas por --max ${max}`);
  }

  console.log('');
  console.log('Leyenda: ELIMINAR = regla determinista · REVISAR = sin prueba suficiente · PROTEGER = datos protegidos');
}

function printAiResult(result: ReclaimAiResult): void {
  console.log('\nGEMMA · EVIDENCIA SOBRE CASOS AMBIGUOS');
  console.log('────────────────────────────────────────');
  console.log(`Modelo: ${result.model}`);
  console.log('Seguridad: Gemma aporta evidencia; NO puede autorizar ELIMINAR.');

  if (result.analyzed.length === 0) {
    console.log('  No hubo candidatos ambiguos analizados.');
  }

  for (const finding of result.analyzed) {
    const e = finding.evidence;
    console.log(`\n${formatBytes(finding.sizeBytes).padStart(10)}  ${finding.path}`);
    console.log(`  Regenerable: ${e.regenerability} · Riesgo datos: ${e.userDataRisk} · Confianza: ${Math.round(e.confidence * 100)}%`);
    console.log(`  Gemma: ${e.reason}`);
    for (const item of e.evidence) console.log(`  - ${item}`);
    console.log('  Decisión efectiva: REVISAR');
  }

  for (const failure of result.failures) {
    console.log(`\n  [AI no disponible] ${failure.path}`);
    console.log(`  ${failure.error}`);
  }
}

async function printReport(
  scan: ScanDocument,
  report: ReturnType<typeof buildReclaimReport>,
  max: number,
  tree: boolean,
  ai: boolean,
  aiMax: number,
): Promise<void> {
  console.log('\nAnSysWarden · Propuestas de espacio');
  console.log('════════════════════════════════════════');
  console.log(`Scan ID: ${scan.id}`);
  console.log(`Origen: ${scan.origin?.deviceRole ?? 'desconocido'} · ${scan.origin?.platform ?? scan.computer}`);
  console.log(`Ruta: ${scan.origin?.rootPath ?? '-'}`);
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

  if (tree) {
    printTree(scan, report, max);
  } else {
    printGroup('ELIMINAR', report.deleteCandidates, max);
    printGroup('REVISAR', report.reviewCandidates, max);
    printGroup('PROTEGER', report.protectCandidates, max);
  }

  if (ai) {
    console.log(`\nAnalizando con Gemma hasta ${aiMax} candidato(s) ambiguo(s) principal(es)...`);
    const result = await analyzeAmbiguousCandidates(scan, report, aiMax);
    printAiResult(result);
  }
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
  const max = readPositiveInt(args, '--max', 30);
  const ai = hasFlag(args, '--ai');
  const aiMax = readPositiveInt(args, '--ai-max', 3);

  if (command === 'scan') {
    const inputPath = args[0];
    if (!inputPath || inputPath.startsWith('--')) usage();
    const tree = hasFlag(args, '--tree');

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
    await printReport(result.scan, buildReclaimReport(result.scan), max, tree, ai, aiMax);
    return;
  }

  if (command === 'latest') {
    const tree = hasFlag(args, '--tree');
    const scan = await findLatestScanHere(storage, cache);
    if (!scan) throw new Error('No hay ningún escaneo disponible en este dispositivo.');
    await printReport(scan, buildReclaimReport(scan), max, tree, ai, aiMax);
    return;
  }

  if (command === 'show') {
    const id = args[0];
    if (!id || id.startsWith('--')) usage();
    const tree = hasFlag(args, '--tree');
    const scan = await findScanHere(storage, cache, id);
    if (!scan) throw new Error(`No existe el escaneo ${id} en este dispositivo.`);
    await printReport(scan, buildReclaimReport(scan), max, tree, ai, aiMax);
    return;
  }

  if (command === 'json') {
    const input = args[0];
    if (!input || input.startsWith('--')) usage();
    const { scan, source } = await loadScanJson(input);
    const tree = !hasFlag(args, '--flat');
    console.log('AnSysWarden · JSON directo');
    console.log('────────────────────────────────────────');
    console.log(`Entrada: ${source}`);
    console.log('Persistencia: no se guarda; solo se analiza en memoria.');
    await printReport(scan, buildReclaimReport(scan), max, tree, ai, aiMax);
    return;
  }

  usage();
}

function displayName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase();
}

function formatDecision(action: ReclaimCandidate['action']): string {
  if (action === 'DELETE') return 'ELIMINAR';
  if (action === 'PROTECT') return 'PROTEGER';
  return 'REVISAR';
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Reclaim] ${message}`);
  process.exitCode = 1;
});
