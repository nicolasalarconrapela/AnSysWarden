import type { ClassificationResult } from '../ai/types';

export const SCAN_SCHEMA = 'ansyswarden.scan.v1' as const;
export const RESULT_SCHEMA = 'ansyswarden.result.v1' as const;

export interface ScanEntry {
  path: string;
  sizeBytes: number;
  files?: number;
  directories?: number;
}

export interface ScanDocument {
  schema: typeof SCAN_SCHEMA;
  id: string;
  createdAt: string;
  source: string;
  computer: string;
  entries: ScanEntry[];
}

export interface ScanResultItem extends ClassificationResult {}

export interface ScanResultDocument {
  schema: typeof RESULT_SCHEMA;
  scanId: string;
  worker: string;
  model: string;
  createdAt: string;
  results: ScanResultItem[];
}

export function isScanDocument(value: unknown): value is ScanDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Record<string, unknown>;
  if (doc.schema !== SCAN_SCHEMA) return false;
  if (!isSafeId(doc.id)) return false;
  if (typeof doc.createdAt !== 'string' || Number.isNaN(Date.parse(doc.createdAt))) return false;
  if (typeof doc.source !== 'string' || doc.source.length === 0 || doc.source.length > 128) return false;
  if (typeof doc.computer !== 'string' || doc.computer.length === 0 || doc.computer.length > 256) return false;
  if (!Array.isArray(doc.entries) || doc.entries.length === 0 || doc.entries.length > 100_000) return false;
  return doc.entries.every(isScanEntry);
}

export function isScanResultDocument(value: unknown): value is ScanResultDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Record<string, unknown>;
  if (doc.schema !== RESULT_SCHEMA) return false;
  if (!isSafeId(doc.scanId)) return false;
  if (typeof doc.worker !== 'string' || doc.worker.length === 0 || doc.worker.length > 256) return false;
  if (typeof doc.model !== 'string' || doc.model.length === 0 || doc.model.length > 256) return false;
  if (typeof doc.createdAt !== 'string' || Number.isNaN(Date.parse(doc.createdAt))) return false;
  if (!Array.isArray(doc.results) || doc.results.length > 100_000) return false;
  return doc.results.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const result = item as Record<string, unknown>;
    return typeof result.path === 'string'
      && ['SAFE_CACHE', 'REVIEW_REQUIRED', 'USER_DATA'].includes(String(result.classification))
      && typeof result.confidence === 'number'
      && Number.isFinite(result.confidence)
      && result.confidence >= 0
      && result.confidence <= 1
      && typeof result.reason === 'string'
      && ['rule', 'ai', 'fallback'].includes(String(result.source));
  });
}

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function isScanEntry(value: unknown): value is ScanEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === 'string'
    && entry.path.length > 0
    && entry.path.length <= 16_384
    && isNonNegative(entry.sizeBytes)
    && isOptionalNonNegative(entry.files)
    && isOptionalNonNegative(entry.directories);
}

function isOptionalNonNegative(value: unknown): boolean {
  return value === undefined || isNonNegative(value);
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
