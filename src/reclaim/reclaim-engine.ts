import type { ScanDocument, ScanEntry } from '../backend/types';
import { classifyByRules } from '../core/classification/rules';

export type ReclaimAction = 'DELETE' | 'REVIEW' | 'PROTECT';

export interface ReclaimCandidate {
  action: ReclaimAction;
  path: string;
  sizeBytes: number;
  reason: string;
  confidence: number;
  source: 'rule' | 'fallback';
}

export interface ReclaimReport {
  scanId: string;
  confirmedRecoverableBytes: number;
  deleteCandidates: ReclaimCandidate[];
  reviewCandidates: ReclaimCandidate[];
  protectCandidates: ReclaimCandidate[];
}

export function buildReclaimReport(scan: ScanDocument): ReclaimReport {
  const candidates = scan.entries
    .filter((entry) => !isScanRoot(entry, scan))
    .map(toCandidate)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);

  const deleteCandidates = candidates.filter((candidate) => candidate.action === 'DELETE');
  const reviewCandidates = candidates.filter((candidate) => candidate.action === 'REVIEW');
  const protectCandidates = candidates.filter((candidate) => candidate.action === 'PROTECT');

  return {
    scanId: scan.id,
    confirmedRecoverableBytes: sumNonOverlapping(deleteCandidates),
    deleteCandidates,
    reviewCandidates,
    protectCandidates,
  };
}

function toCandidate(entry: ScanEntry): ReclaimCandidate {
  const classification = classifyByRules(entry.path);

  if (!classification) {
    return {
      action: 'REVIEW',
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      reason: 'No deterministic rule can prove that this content is safely regenerable.',
      confidence: 0,
      source: 'fallback',
    };
  }

  if (classification.classification === 'SAFE_CACHE') {
    return {
      action: 'DELETE',
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      reason: classification.reason,
      confidence: classification.confidence,
      source: 'rule',
    };
  }

  if (classification.classification === 'USER_DATA') {
    return {
      action: 'PROTECT',
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      reason: classification.reason,
      confidence: classification.confidence,
      source: 'rule',
    };
  }

  return {
    action: 'REVIEW',
    path: entry.path,
    sizeBytes: entry.sizeBytes,
    reason: classification.reason,
    confidence: classification.confidence,
    source: classification.source === 'rule' ? 'rule' : 'fallback',
  };
}

function isScanRoot(entry: ScanEntry, scan: ScanDocument): boolean {
  const rootPath = scan.origin?.rootPath;
  if (!rootPath) return entry.depth === 0;
  return normalizePath(entry.path) === normalizePath(rootPath);
}

function sumNonOverlapping(candidates: ReclaimCandidate[]): number {
  const selected: ReclaimCandidate[] = [];
  let total = 0;

  for (const candidate of [...candidates].sort((a, b) => b.sizeBytes - a.sizeBytes)) {
    if (selected.some((parent) => isSameOrDescendant(candidate.path, parent.path))) continue;
    selected.push(candidate);
    total += candidate.sizeBytes;
  }

  return total;
}

function isSameOrDescendant(path: string, parent: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedParent = normalizePath(parent).replace(/\/$/, '');
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit >= 3 ? 2 : unit >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}
