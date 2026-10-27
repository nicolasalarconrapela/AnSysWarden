import type { ClassificationResult } from '../classification/types';
import type { ArtifactProfile } from './artifact-profile';

export const SCAN_SCHEMA = 'ansyswarden.scan.v1' as const;
export const RESULT_SCHEMA = 'ansyswarden.result.v1' as const;
export const AI_JOB_SCHEMA = 'ansyswarden.ai-job.v1' as const;
export const AI_JOB_RESULT_SCHEMA = 'ansyswarden.ai-job-result.v1' as const;

export interface ScanEntry {
  entryId?: string;
  parentId?: string;
  depth?: number;
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

export interface AiJobDocument {
  schema: typeof AI_JOB_SCHEMA;
  id: string;
  createdAt: string;
  profile: ArtifactProfile;
}

export interface AiJobResultDocument {
  schema: typeof AI_JOB_RESULT_SCHEMA;
  jobId: string;
  worker: string;
  model: string;
  createdAt: string;
  result: ClassificationResult;
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
  if (!doc.entries.every(isScanEntry)) return false;
  return hasValidOptionalHierarchy(doc.entries as ScanEntry[]);
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
  return doc.results.every(isClassificationResult);
}

export function isAiJobDocument(value: unknown): value is AiJobDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Record<string, unknown>;
  return doc.schema === AI_JOB_SCHEMA
    && isSafeId(doc.id)
    && typeof doc.createdAt === 'string'
    && !Number.isNaN(Date.parse(doc.createdAt))
    && isArtifactProfile(doc.profile);
}

export function isAiJobResultDocument(value: unknown): value is AiJobResultDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Record<string, unknown>;
  if (doc.schema !== AI_JOB_RESULT_SCHEMA) return false;
  if (!isSafeId(doc.jobId)) return false;
  if (typeof doc.worker !== 'string' || doc.worker.length === 0 || doc.worker.length > 256) return false;
  if (typeof doc.model !== 'string' || doc.model.length === 0 || doc.model.length > 256) return false;
  if (typeof doc.createdAt !== 'string' || Number.isNaN(Date.parse(doc.createdAt))) return false;
  if (!isClassificationResult(doc.result)) return false;

  // Remote/mobile workers never have authority to approve deletion.
  return doc.result.classification !== 'SAFE_CACHE'
    && (doc.result.source === 'ai' || doc.result.source === 'fallback');
}

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function isClassificationResult(value: unknown): value is ClassificationResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.path === 'string'
    && result.path.length > 0
    && result.path.length <= 16_384
    && ['SAFE_CACHE', 'REVIEW_REQUIRED', 'USER_DATA'].includes(String(result.classification))
    && typeof result.confidence === 'number'
    && Number.isFinite(result.confidence)
    && result.confidence >= 0
    && result.confidence <= 1
    && typeof result.reason === 'string'
    && result.reason.length > 0
    && ['rule', 'ai', 'fallback'].includes(String(result.source));
}

function isArtifactProfile(value: unknown): value is ArtifactProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Record<string, unknown>;
  if (typeof profile.path !== 'string' || profile.path.length === 0 || profile.path.length > 16_384) return false;
  if (!isNonNegative(profile.sizeBytes)) return false;
  if (!isNonNegative(profile.fileCount)) return false;
  if (!isNonNegative(profile.directoryCount)) return false;
  if (!isNonNegative(profile.skippedEntries)) return false;
  if (!isOptionalTimestamp(profile.newestMtimeMs)) return false;
  if (!isOptionalTimestamp(profile.oldestMtimeMs)) return false;
  if (profile.profileComplete !== undefined && typeof profile.profileComplete !== 'boolean') return false;
  if (profile.limitReason !== undefined
    && profile.limitReason !== null
    && !['MAX_FILES', 'MAX_DIRECTORIES', 'MAX_DURATION'].includes(String(profile.limitReason))) return false;
  if (!Array.isArray(profile.extensions) || profile.extensions.length > 1_000) return false;
  return profile.extensions.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const extension = item as Record<string, unknown>;
    return typeof extension.extension === 'string'
      && extension.extension.length <= 128
      && isNonNegative(extension.files)
      && isNonNegative(extension.bytes);
  });
}

function isScanEntry(value: unknown): value is ScanEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === 'string'
    && entry.path.length > 0
    && entry.path.length <= 16_384
    && isNonNegative(entry.sizeBytes)
    && isOptionalNonNegative(entry.files)
    && isOptionalNonNegative(entry.directories)
    && isOptionalSafeId(entry.entryId)
    && isOptionalSafeId(entry.parentId)
    && isOptionalDepth(entry.depth);
}

function hasValidOptionalHierarchy(entries: ScanEntry[]): boolean {
  const entriesWithId = entries.filter((entry) => entry.entryId !== undefined);
  if (entriesWithId.length === 0) return true;
  if (entriesWithId.length !== entries.length) return false;

  const ids = new Set<string>();
  for (const entry of entriesWithId) {
    if (!entry.entryId || ids.has(entry.entryId)) return false;
    ids.add(entry.entryId);
  }

  for (const entry of entriesWithId) {
    if (entry.parentId !== undefined && !ids.has(entry.parentId)) return false;
    if (entry.parentId === entry.entryId) return false;
  }

  return true;
}

function isOptionalSafeId(value: unknown): boolean {
  return value === undefined || isSafeId(value);
}

function isOptionalDepth(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1024);
}

function isOptionalNonNegative(value: unknown): boolean {
  return value === undefined || isNonNegative(value);
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null || isNonNegative(value);
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
