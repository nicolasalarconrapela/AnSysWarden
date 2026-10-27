import type { ClassificationResult } from '../../core/classification/types';
import type { PathClassifier } from '../../ai/classifier';
import type { TraceLogger } from '../../observability/logger';
import { DirectoryMeasurer } from '../../infrastructure/filesystem/directory-measurer';

export interface ScanOptions {
  minBytes?: number;
  maxCandidates?: number;
}

export interface ScanCandidate extends ClassificationResult {
  sizeBytes: number;
}

export interface ScanSummary {
  root: string;
  scannedFiles: number;
  scannedDirectories: number;
  skippedEntries: number;
  totalBytes: number;
  candidates: ScanCandidate[];
  recoverableBytes: number;
}

const DEFAULT_MIN_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_CANDIDATES = 20;

function normalizedOverlapPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalized || '/';
}

function isDescendantPath(parent: string, child: string): boolean {
  const normalizedParent = normalizedOverlapPath(parent);
  const normalizedChild = normalizedOverlapPath(child);
  if (normalizedParent === '/') return normalizedChild !== '/';
  return normalizedChild !== normalizedParent && normalizedChild.startsWith(`${normalizedParent}/`);
}

export function selectRecoverableSafeCandidates(candidates: ScanCandidate[]): ScanCandidate[] {
  const safeCandidates = candidates
    .filter((candidate) => candidate.classification === 'SAFE_CACHE')
    .sort((a, b) => normalizedOverlapPath(a.path).length - normalizedOverlapPath(b.path).length);

  const selected: ScanCandidate[] = [];

  for (const candidate of safeCandidates) {
    const hasNonSafeDescendant = candidates.some(
      (other) => other.classification !== 'SAFE_CACHE'
        && isDescendantPath(candidate.path, other.path),
    );
    if (hasNonSafeDescendant) continue;

    const alreadyCoveredBySelectedAncestor = selected.some(
      (ancestor) => normalizedOverlapPath(ancestor.path) === normalizedOverlapPath(candidate.path)
        || isDescendantPath(ancestor.path, candidate.path),
    );
    if (!alreadyCoveredBySelectedAncestor) selected.push(candidate);
  }

  return selected;
}

export function removeOverlappingSafeCandidates(candidates: ScanCandidate[]): ScanCandidate[] {
  const recoverableSafePaths = new Set(
    selectRecoverableSafeCandidates(candidates).map((candidate) => normalizedOverlapPath(candidate.path)),
  );

  return candidates.filter((candidate) => (
    candidate.classification !== 'SAFE_CACHE'
    || recoverableSafePaths.has(normalizedOverlapPath(candidate.path))
  ));
}

export class ScanService {
  private readonly measurer: DirectoryMeasurer;

  constructor(
    private readonly classifier: PathClassifier,
    private readonly logger: TraceLogger,
    measurer?: DirectoryMeasurer,
  ) {
    this.measurer = measurer ?? new DirectoryMeasurer(logger);
  }

  async scan(inputRoot: string, options: ScanOptions = {}): Promise<ScanSummary> {
    const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;
    const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

    await this.logger.info('scan.config', 'Scan configuration', {
      root: inputRoot,
      min_bytes: minBytes,
      max_candidates: maxCandidates,
      follow_symlinks: false,
      destructive_actions: false,
    });

    const measurement = await this.measurer.measure(inputRoot);
    const candidateDirs = measurement.directories
      .filter((entry) => entry.sizeBytes >= minBytes)
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .slice(0, maxCandidates);

    await this.logger.info('scan.candidates', 'Candidates detected', {
      count: candidateDirs.length,
      min_bytes: minBytes,
      largest: candidateDirs.slice(0, 5),
    });

    const classifiedCandidates: ScanCandidate[] = [];
    for (const candidate of candidateDirs) {
      const classification = await this.classifier.classify(candidate.path);
      const result: ScanCandidate = { ...classification, sizeBytes: candidate.sizeBytes };
      classifiedCandidates.push(result);
      await this.logger.info('scan.candidate.result', 'Candidate classified', {
        path: result.path,
        size_bytes: result.sizeBytes,
        classification: result.classification,
        confidence: result.confidence,
        source: result.source,
        reason: result.reason,
      });
    }

    const recoverableCandidates = selectRecoverableSafeCandidates(classifiedCandidates);
    const recoverableBytes = recoverableCandidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
    const safeCandidateCount = classifiedCandidates.filter((candidate) => candidate.classification === 'SAFE_CACHE').length;
    const blockedOrOverlappedSafeCount = safeCandidateCount - recoverableCandidates.length;

    if (blockedOrOverlappedSafeCount > 0) {
      await this.logger.info('scan.recoverable.filtered', 'SAFE_CACHE entries excluded from recoverable total due to overlap or unsafe descendants', {
        safe_candidate_count: safeCandidateCount,
        recoverable_candidate_count: recoverableCandidates.length,
        excluded_safe_count: blockedOrOverlappedSafeCount,
        recoverable_paths: recoverableCandidates.map((candidate) => candidate.path),
      });
    }

    const summary: ScanSummary = {
      root: measurement.root,
      scannedFiles: measurement.scannedFiles,
      scannedDirectories: measurement.scannedDirectories,
      skippedEntries: measurement.skippedEntries,
      totalBytes: measurement.totalBytes,
      candidates: classifiedCandidates,
      recoverableBytes,
    };

    await this.logger.info('scan.complete', 'Scan completed', {
      root: summary.root,
      scanned_files: summary.scannedFiles,
      scanned_directories: summary.scannedDirectories,
      skipped_entries: summary.skippedEntries,
      total_bytes: summary.totalBytes,
      candidate_count: summary.candidates.length,
      recoverable_candidate_count: recoverableCandidates.length,
      recoverable_bytes: summary.recoverableBytes,
    });

    return summary;
  }
}
