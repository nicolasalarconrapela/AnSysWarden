/**
 * Preparación local de fichas Tree para revisión humana.
 * Lee exclusivamente el JSONL guardado; no accede a los archivos originales.
 * No hay red, modelos IA ni operaciones destructivas.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { TREE_INDEX_SCHEMA, type TreeIndexRecord, type TreeScanMetadata } from '../core/inventory/tree-types';

export const AI_REVIEW_SCHEMA = 'ansyswarden.tree-ai-review.v1' as const;
const MAX_CANDIDATES = 60;
const MAX_RECORDS = 5_000_000;
const PRIVATE_PART = /^(?:documents?|documentos|escritorio|desktop|photos?|fotos?|pictures?|dcim|backups?|personal|private|privado|finanzas|bancos?|contratos?|secrets?|credentials?)$/i;
const KEEP_MARKER = /(?:^|[-_. ])KEEP(?:$|[-_. ])/i;

export type AiFolderKind = 'dependencias' | 'compilacion' | 'cache' | 'temporal' | 'desconocido';
export type AiFileCategory = 'codigo' | 'documentos' | 'imagenes' | 'videos' | 'comprimidos' | 'binarios' | 'otros';
export interface AiFolderReview {
  id: string;
  path: string; // Solo la página y el mapa privado del PC
  relativePath: string; // Solo la página local, nunca la exportación aprobada
  eligible: boolean;
  reason: string;
  profile: {
    folderKind: AiFolderKind;
    sizeBytes: number;
    fileCount: number;
    directoryCount: number;
    skippedEntries: number;
    profileComplete: boolean;
    newestMtimeMs: number | null;
    oldestMtimeMs: number | null;
    extensions: Array<{ extension: AiFileCategory; files: number; bytes: number }>;
  };
}
export interface AiReview {
  schema: typeof AI_REVIEW_SCHEMA;
  previewId: string;
  scanId: string;
  capturedAt: string;
  generatedAt: string;
  complete: boolean;
  totalDirectories: number;
  totalFiles: number;
  errors: number;
  shown: number;
  omitted: number;
  folders: AiFolderReview[];
}
interface Candidate {
  path: string;
  relativePath: string;
  sizeBytes: number;
  files: number;
  directories: number;
  errors: number;
  newest: number | null;
  oldest: number | null;
  categories: Map<AiFileCategory, { files: number; bytes: number }>;
}
function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function fileCategory(name: string): AiFileCategory {
  const ext = extname(name).toLowerCase();
  if (['.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.kt', '.rs', '.go', '.cpp', '.c', '.h', '.json', '.xml', '.css', '.html', '.yaml', '.yml'].includes(ext)) return 'codigo';
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.odt'].includes(ext)) return 'documentos';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.svg'].includes(ext)) return 'imagenes';
  if (['.mp4', '.mkv', '.mov', '.avi', '.webm'].includes(ext)) return 'videos';
  if (['.zip', '.rar', '.7z', '.gz', '.tar', '.xz'].includes(ext)) return 'comprimidos';
  if (['.exe', '.dll', '.bin', '.class', '.jar', '.so'].includes(ext)) return 'binarios';
  return 'otros';
}
function isCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}
function childPath(root: string, path: string): string | null {
  const r = relative(root, resolve(path));
  if (!r) return '';
  if (r === '..' || r.startsWith('../') || r.startsWith('..\\') || isAbsolute(r)) return null;
  return r;
}
function kind(name: string): AiFolderKind {
  if (/^(node_modules|vendor|venv|\.venv)$/i.test(name)) return 'dependencias';
  if (/^(build|dist|out|target|\.gradle)$/i.test(name)) return 'compilacion';
  if (/^(\.cache|cache|caches|__pycache__)$/i.test(name)) return 'cache';
  if (/^(temp|tmp|temporales?)$/i.test(name)) return 'temporal';
  return 'desconocido';
}
function addLargest(items: Candidate[], item: Candidate, limit: number): void {
  if (items.length < limit) { items.push(item); return; }
  let smallest = 0;
  for (let i = 1; i < items.length; i++) {
    if (items[i].sizeBytes < items[smallest].sizeBytes) smallest = i;
  }
  if (item.sizeBytes > items[smallest].sizeBytes) items[smallest] = item;
}
async function* readRecords(indexPath: string): AsyncGenerator<TreeIndexRecord> {
  const stream = createReadStream(indexPath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      lineNo++;
      if (lineNo > MAX_RECORDS || line.length > 65536) {
        throw new Error('Índice demasiado grande para esta vista previa.');
      }
      let item: TreeIndexRecord;
      try { item = JSON.parse(line) as TreeIndexRecord; }
      catch { throw new Error('JSONL ilegible en el registro ' + lineNo); }
      if (!item || !['entry', 'directory-summary', 'error'].includes(item.record)) {
        throw new Error('Registro desconocido en el JSONL.');
      }
      yield item;
    }
  } finally {
    reader.close();
    stream.destroy();
  }
}
export async function buildAiReview(metadata: TreeScanMetadata, limit = MAX_CANDIDATES): Promise<AiReview> {
  if (metadata.schema !== TREE_INDEX_SCHEMA || !/^[A-Za-z0-9._-]{1,128}$/.test(metadata.id)
    || !metadata.rootPath || !metadata.indexPath || !isCount(metadata.entries) || metadata.entries === 0) {
    throw new Error('Metadatos Tree incompletos o inválidos.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CANDIDATES) {
    throw new Error('Límite de carpetas inválido (1..60).');
  }
  const root = resolve(metadata.rootPath);
  const candidates: Candidate[] = [];
  let entries = 0, files = 0, dirs = 0, errors = 0, summaries = 0, symlinks = 0, others = 0;
  let rootSummary: { sizeBytes: number; files: number } | undefined;
  for await (const item of readRecords(resolve(metadata.indexPath))) {
    if (typeof item.path !== 'string') throw new Error('Registro sin ruta.');
    const rel = childPath(root, item.path);
    if (rel === null) throw new Error('Ruta del índice fuera de la raíz: se bloquea la revisión.');
    if (item.record === 'entry') {
      entries++;
      if (item.type === 'directory') dirs++;
      else if (item.type === 'file') files++;
      else if (item.type === 'symlink') symlinks++;
      else others++;
    } else if (item.record === 'error') errors++;
    else {
      summaries++;
      if (![item.sizeBytes, item.files, item.directories, item.errors].every(isCount)) {
        throw new Error('Recuentos inválidos en un directorio.');
      }
      if (!rel) {
        rootSummary = { sizeBytes: item.sizeBytes, files: item.files };
        continue;
      }
      addLargest(candidates, {
        path: resolve(item.path), relativePath: rel,
        sizeBytes: item.sizeBytes, files: item.files,
        directories: item.directories, errors: item.errors,
        newest: null, oldest: null, categories: new Map(),
      }, limit);
    }
  }
  if (entries !== metadata.entries || files !== metadata.files || dirs !== metadata.directories
    || errors !== metadata.errors || symlinks !== metadata.symlinks
    || others !== metadata.others || summaries !== dirs || !rootSummary
    || rootSummary.files !== files || rootSummary.sizeBytes !== metadata.sizeBytes) {
    throw new Error('El índice y el manifiesto no coinciden: revisión bloqueada.');
  }
  // Conservador: cualquier enlace o entrada especial impide aprobación
  // aunque los recuentos del índice estén completos.
  const complete = errors === 0 && symlinks === 0 && others === 0;
  // Segunda lectura SOLO del índice para agrupar fechas y tipos de archivo
  // por cada carpeta de la selección. No abre ningún fichero original.
  const lookup = new Map(candidates.map(item => [pathKey(item.path), item]));
  for await (const record of readRecords(resolve(metadata.indexPath))) {
    if (record.record !== 'entry' || record.type !== 'file') continue;
    if (!isCount(record.sizeBytes) || typeof record.name !== 'string') {
      throw new Error('Tamaño o nombre de archivo inválido en la captura.');
    }
    let parent = dirname(resolve(record.path));
    while (childPath(root, parent) !== null) {
      const candidate = lookup.get(pathKey(parent));
      if (candidate) {
        const category = fileCategory(record.name);
        const current = candidate.categories.get(category) ?? { files: 0, bytes: 0 };
        current.files++;
        current.bytes += record.sizeBytes;
        candidate.categories.set(category, current);
        if (Number.isFinite(record.mtimeMs) && record.mtimeMs >= 0) {
          candidate.newest = Math.max(candidate.newest ?? record.mtimeMs, record.mtimeMs);
          candidate.oldest = Math.min(candidate.oldest ?? record.mtimeMs, record.mtimeMs);
        }
      }
      if (pathKey(parent) === pathKey(root)) break;
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  if (complete && candidates.some(item => {
    const totals = [...item.categories.values()];
    return totals.reduce((n, v) => n + v.files, 0) !== item.files
      || totals.reduce((n, v) => n + v.bytes, 0) !== item.sizeBytes;
  })) {
    throw new Error('El resumen de una carpeta no coincide con los registros de archivo.');
  }
  candidates.sort((a,b) => b.sizeBytes - a.sizeBytes || a.relativePath.localeCompare(b.relativePath));
  const folders = candidates.map(item => {
    const protectedName = item.relativePath.split(/[\\/]/).some(s => PRIVATE_PART.test(s) || KEEP_MARKER.test(s));
    const reason = !complete ? 'Captura con errores, enlaces simbólicos o entradas especiales: aprobación bloqueada.'
      : item.errors ? 'Carpeta con errores de lectura.'
      : protectedName ? 'Datos personales, copia o marcador KEEP: protegida.'
      : item.files === 0 ? 'Carpeta sin archivos.'
      : 'Se puede preparar una ficha para revisión IA; NO autoriza envío ni borrado.';
    const eligible = complete && item.errors === 0 && !protectedName && item.files > 0;
    return {
      id: randomUUID(),
      path: item.path, relativePath: item.relativePath, eligible, reason,
      profile: {
        folderKind: kind(basename(item.path)), sizeBytes: item.sizeBytes,
        fileCount: item.files, directoryCount: item.directories,
        skippedEntries: item.errors, profileComplete: complete && item.errors === 0,
        newestMtimeMs: item.newest, oldestMtimeMs: item.oldest,
        extensions: [...item.categories].map(([extension, totals]) => ({ extension, ...totals }))
          .sort((a, b) => b.bytes - a.bytes),
      },
    };
  });
  return {
    schema: AI_REVIEW_SCHEMA, previewId: randomUUID(), scanId: metadata.id,
    capturedAt: metadata.createdAt, generatedAt: new Date().toISOString(),
    complete, totalDirectories: dirs, totalFiles: files, errors,
    shown: folders.length, omitted: Math.max(0, dirs - 1 - folders.length), folders,
  };
}
