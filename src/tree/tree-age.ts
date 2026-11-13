import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve, join } from 'node:path';
import type { TreeIndexRecord, TreeScanMetadata } from './native-tree-scanner';

export interface AgeReport {
  schema: 'ansyswarden.tree-age.v1';
  scanId: string;
  createdAt: string;
  referenceAt: string;
  thresholdDays: number;
  totalFiles: number;
  staleFiles: number;
  staleLogicalBytes: number;
  undatedFiles: number;
  futureDatedFiles: number;
  buckets: { label: string; files: number; bytes: number }[];
  largestUnmodified: { path: string; sizeBytes: number; modifiedAt: string; ageDays: number }[];
  limitations: string[];
}

export async function analyzeTreeAge(
  metadata: TreeScanMetadata,
  options: { days?: number; top?: number; outputPath?: string } = {},
): Promise<{ report: AgeReport; outputPath: string }> {
  const days = options.days ?? 180;
  const top = options.top ?? 25;
  if (!Number.isSafeInteger(days) || days < 1 || days > 36500) {
    throw new Error('--days debe ser un entero entre 1 y 36500');
  }
  if (!Number.isSafeInteger(top) || top < 1 || top > 200) {
    throw new Error('--top debe ser un entero entre 1 y 200');
  }
  const reference = Date.parse(metadata.createdAt);
  if (!Number.isFinite(reference)) throw new Error('Fecha de escaneo inválida: ' + metadata.createdAt);
  const DAY_MS = 86_400_000;
  const limits = [30, 90, 180, 365];
  const labels = ['0–29 días', '30–89 días', '90–179 días', '180–364 días', '365+ días'];
  const buckets = labels.map(label => ({ label, files: 0, bytes: 0 }));
  const largest: AgeReport['largestUnmodified'] = [];
  let totalFiles = 0, staleFiles = 0, staleLogicalBytes = 0;
  let undatedFiles = 0, futureDatedFiles = 0;

  const input = createReadStream(metadata.indexPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as TreeIndexRecord;
    if (record.record !== 'entry' || record.type !== 'file') continue;
    totalFiles++;
    const modified = record.mtimeMs;
    if (!Number.isFinite(modified) || modified <= 0) {
      undatedFiles++;
      continue;
    }
    if (modified > reference) {
      futureDatedFiles++;
      continue;
    }
    const ageDays = Math.floor((reference - modified) / DAY_MS);
    const bucketIndex = limits.findIndex(limit => ageDays < limit);
    const bucket = buckets[bucketIndex === -1 ? buckets.length - 1 : bucketIndex];
    bucket.files++;
    bucket.bytes += record.sizeBytes;
    if (ageDays < days) continue;
    staleFiles++;
    staleLogicalBytes += record.sizeBytes;
    const candidate = {
      path: record.path,
      sizeBytes: record.sizeBytes,
      modifiedAt: new Date(modified).toISOString(),
      ageDays,
    };
    if (largest.length < top || candidate.sizeBytes > largest[largest.length - 1].sizeBytes) {
      largest.push(candidate);
      largest.sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path));
      if (largest.length > top) largest.pop();
    }
  }

  const report: AgeReport = {
    schema: 'ansyswarden.tree-age.v1',
    scanId: metadata.id,
    createdAt: metadata.createdAt,
    referenceAt: metadata.createdAt,
    thresholdDays: days,
    totalFiles,
    staleFiles,
    staleLogicalBytes,
    undatedFiles,
    futureDatedFiles,
    buckets,
    largestUnmodified: largest,
    limitations: [
      'Antigüedad calculada respecto al instante del escaneo, no respecto al momento actual.',
      'La fecha mtime indica modificación, no último uso ni último acceso.',
      'Un archivo antiguo puede ser necesario, irremplazable o costoso de regenerar.',
      'Este análisis no autoriza eliminación ni modifica archivos originales.',
      'El tamaño es lógico, no espacio físico asignado.',
    ],
  };
  const outputPath = resolve(options.outputPath ??
    join(process.cwd(), '.ansyswarden', 'tree', 'reports', metadata.id + '-age-' + days + 'd.json'));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return { report, outputPath };
}
