import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import type { TreeIndexRecord, TreeScanMetadata } from './native-tree-scanner';

export const TREE_ACTIVITY_SCHEMA = 'ansyswarden.tree-activity.v1' as const;

export type ActivityState = 'RECIENTE' | 'SIN_CAMBIOS_RECIENTES' | 'INDETERMINADA' | 'FECHA_FUTURA';
export type ReviewStatus = 'OBSERVAR' | 'REVISAR';

export interface ActivityCandidate {
  path: string;
  family: string;
  evidence: string;
  confidence: 'ALTA' | 'MEDIA';
  files: number;
  directories: number;
  logicalBytes: number;
  lastContentChange: string | null;
  daysSinceChange: number | null;
  unknownDates: number;
  futureDates: number;
  activity: ActivityState;
  suggestion: ReviewStatus;
  reason: string;
}

export interface ActivityReport {
  schema: typeof TREE_ACTIVITY_SCHEMA;
  scanId: string;
  referenceAt: string;
  generatedAt: string;
  thresholdDays: number;
  scannedFiles: number;
  candidatesFound: number;
  candidatesToReview: number;
  families: { family: string; folders: number; logicalBytes: number }[];
  candidates: ActivityCandidate[];
  limitations: string[];
}

export function defaultActivityPath(metadata: TreeScanMetadata): string {
  return resolve('.ansyswarden', 'tree', 'reports', metadata.id + '-activity.json');
}

type Match = Pick<ActivityCandidate, 'family' | 'evidence' | 'confidence'>;

export function detectArtifactFamily(name: string): Match | null {
  // Coincidencia exacta: nunca reconocer subcadenas como "rebuild" o
  // "node_modules_backup". Los nombres genéricos son solo indicios.
  const normalized = name.toLowerCase();
  const known: Record<string, Match> = {
    node_modules: { family: 'Dependencias Node.js', evidence: 'Carpeta llamada node_modules', confidence: 'ALTA' },
    '.gradle': { family: 'Estado local Gradle', evidence: 'Carpeta llamada .gradle', confidence: 'ALTA' },
    '.next': { family: 'Salida de Next.js', evidence: 'Carpeta llamada .next', confidence: 'ALTA' },
    '.nuxt': { family: 'Salida de Nuxt', evidence: 'Carpeta llamada .nuxt', confidence: 'ALTA' },
    __pycache__: { family: 'Bytecode Python', evidence: 'Carpeta llamada __pycache__', confidence: 'ALTA' },
    '.pytest_cache': { family: 'Caché pytest', evidence: 'Carpeta llamada .pytest_cache', confidence: 'ALTA' },
    '.mypy_cache': { family: 'Caché mypy', evidence: 'Carpeta llamada .mypy_cache', confidence: 'ALTA' },
    '.ruff_cache': { family: 'Caché Ruff', evidence: 'Carpeta llamada .ruff_cache', confidence: 'ALTA' },
    '.turbo': { family: 'Caché Turborepo', evidence: 'Carpeta llamada .turbo', confidence: 'ALTA' },
    '.parcel-cache': { family: 'Caché Parcel', evidence: 'Carpeta llamada .parcel-cache', confidence: 'ALTA' },
    'dist': { family: 'Posible salida compilada', evidence: 'Nombre genérico dist; verificar el proyecto', confidence: 'MEDIA' },
    'build': { family: 'Posible salida de compilación', evidence: 'Nombre genérico build; puede contener datos importantes', confidence: 'MEDIA' },
    'target': { family: 'Posible salida Maven/Rust', evidence: 'Nombre genérico target; verificar antes de actuar', confidence: 'MEDIA' },
    'out': { family: 'Posible salida generada', evidence: 'Nombre genérico out; verificar antes de actuar', confidence: 'MEDIA' },
  };
  return known[normalized] ?? null;
}

interface WorkingCandidate extends ActivityCandidate {
  newestMs: number;
}

export async function analyzeTreeActivity(
  metadata: TreeScanMetadata,
  options: { days?: number; outputPath?: string } = {},
): Promise<{ report: ActivityReport; outputPath: string }> {
  const days = options.days ?? 180;
  if (!Number.isSafeInteger(days) || days < 1 || days > 36500) {
    throw new Error('--days debe ser un entero entre 1 y 36500.');
  }
  const reference = Date.parse(metadata.createdAt);
  if (!Number.isFinite(reference)) throw new Error('Fecha de escaneo inválida.');
  if (metadata.entries === 0) throw new Error('No hay entradas para analizar.');

  const candidates: WorkingCandidate[] = [];
  const active: WorkingCandidate[] = [];
  let scannedFiles = 0;
  const lines = createInterface({
    input: createReadStream(metadata.indexPath, { encoding: 'utf8' }), crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as TreeIndexRecord;
    if (record.record === 'entry') {
      if (record.type === 'directory') {
        // Las familias anidadas se agrupan en la carpeta raíz reconocida.
        const match = active.length ? null : detectArtifactFamily(record.name);
        if (match) {
          const candidate: WorkingCandidate = {
            path: record.path, ...match, files: 0, directories: 0, logicalBytes: 0,
            lastContentChange: null, daysSinceChange: null,
            unknownDates: 0, futureDates: 0, activity: 'INDETERMINADA',
            suggestion: 'OBSERVAR', reason: '', newestMs: 0,
          };
          active.push(candidate);
          candidates.push(candidate);
        }
      } else if (record.type === 'file') {
        scannedFiles++;
        const current = active[active.length - 1];
        if (!current) continue;
        const mtime = record.mtimeMs;
        if (!Number.isFinite(mtime) || mtime <= 0) {
          current.unknownDates++;
        } else if (mtime > reference) {
          current.futureDates++;
        } else {
          current.newestMs = Math.max(current.newestMs, mtime);
        }
      }
    } else if (record.record === 'directory-summary') {
      const current = active[active.length - 1];
      if (current && current.path === record.path) {
        current.files = record.files;
        current.directories = record.directories;
        current.logicalBytes = record.sizeBytes;
        active.pop();
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate.newestMs > 0) {
      candidate.lastContentChange = new Date(candidate.newestMs).toISOString();
      candidate.daysSinceChange = Math.floor((reference - candidate.newestMs) / 86_400_000);
    }
    if (candidate.futureDates > 0) {
      candidate.activity = 'FECHA_FUTURA';
      candidate.reason = 'Hay fechas de modificación posteriores a la captura; revisar el reloj y los metadatos.';
    } else if (candidate.unknownDates > 0 || candidate.daysSinceChange === null) {
      candidate.activity = 'INDETERMINADA';
      candidate.reason = 'Fechas de modificación insuficientes para determinar la actividad.';
    } else if (candidate.daysSinceChange >= days) {
      candidate.activity = 'SIN_CAMBIOS_RECIENTES';
      candidate.suggestion = 'REVISAR';
      candidate.reason = 'Sin cambios de contenido registrados durante al menos ' + days +
        ' días; comprobar si sigue siendo necesario.';
    } else {
      candidate.activity = 'RECIENTE';
      candidate.reason = 'Se han registrado modificaciones de contenido dentro del umbral.';
    }
  }

  const familyMap = new Map<string, { family: string; folders: number; logicalBytes: number }>();
  for (const candidate of candidates) {
    const f = familyMap.get(candidate.family) ??
      { family: candidate.family, folders: 0, logicalBytes: 0 };
    f.folders++;
    f.logicalBytes += candidate.logicalBytes;
    familyMap.set(candidate.family, f);
  }
  const sorted = candidates.sort((a, b) => b.logicalBytes - a.logicalBytes ||
    a.path.localeCompare(b.path));
  const report: ActivityReport = {
    schema: TREE_ACTIVITY_SCHEMA,
    scanId: metadata.id,
    referenceAt: metadata.createdAt,
    generatedAt: new Date().toISOString(),
    thresholdDays: days,
    scannedFiles,
    candidatesFound: sorted.length,
    candidatesToReview: sorted.filter(c => c.suggestion === 'REVISAR').length,
    families: [...familyMap.values()].sort((a, b) => b.logicalBytes - a.logicalBytes),
    candidates: sorted.map(({ newestMs: _ignored, ...c }) => c),
    limitations: [
      'Solo se consulta el índice existente; no se abren, modifican ni eliminan archivos originales.',
      'La fecha de modificación (mtime) no prueba último uso. atime tampoco acredita uso humano.',
      'El reconocimiento se basa en nombres de carpetas; build, dist, target y out son indicios débiles.',
      'REVISAR es una sugerencia para inspección humana y nunca una autorización para eliminar.',
      'Las familias anidadas se agrupan en la primera carpeta de artefactos detectada.',
      'El tamaño es lógico y puede diferir del espacio ocupado en disco.',
    ],
  };
  const outputPath = resolve(options.outputPath ?? defaultActivityPath(metadata));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return { report, outputPath };
}
