import { opendir, lstat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { PathClassifier } from '../ai/classifier';
import type { ClassificationResult } from '../ai/types';
import { TraceLogger } from '../observability/logger';

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

interface DirectoryMeasure {
  path: string;
  sizeBytes: number;
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

/**
 * Selects only SAFE_CACHE candidates whose bytes can be summed without
 * overlaps and without crossing a known descendant that requires review or
 * is protected as user data.
 *
 * Conservative policy:
 * - SAFE parent + SAFE child: count the parent once.
 * - SAFE parent + REVIEW/USER_DATA descendant: do NOT count the parent.
 * - REVIEW/USER_DATA parent + SAFE child: the child may still count.
 * - If a SAFE parent is blocked, other independent SAFE descendants may still
 *   contribute their own bytes.
 */
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

/**
 * Compatibility with earlier callers: returns only SAFE_CACHE candidates that
 * can be counted conservatively. Do not use this to hide UI candidates.
 */
export function removeOverlappingSafeCandidates(candidates: ScanCandidate[]): ScanCandidate[] {
  const recoverableSafePaths = new Set(
    selectRecoverableSafeCandidates(candidates).map((candidate) => normalizedOverlapPath(candidate.path)),
  );

  return candidates.filter((candidate) => (
    candidate.classification !== 'SAFE_CACHE'
    || recoverableSafePaths.has(normalizedOverlapPath(candidate.path))
  ));
}

export class LocalScanner {
  private scannedFiles = 0;
  private scannedDirectories = 0;
  private skippedEntries = 0;
  private readonly measuredDirectories: DirectoryMeasure[] = [];

  constructor(
    private readonly classifier: PathClassifier,
    private readonly logger: TraceLogger,
  ) {}

  async scan(inputRoot: string, options: ScanOptions = {}): Promise<ScanSummary> {
    const root = resolve(inputRoot);
    const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;
    const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

    this.scannedFiles = 0;
    this.scannedDirectories = 0;
    this.skippedEntries = 0;
    this.measuredDirectories.length = 0;

    await this.logger.info('scan.config', 'Scan configuration', {
      root,
      min_bytes: minBytes,
      max_candidates: maxCandidates,
      follow_symlinks: false,
      destructive_actions: false,
    });

    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) {
      throw new Error(`Scan path is not a directory: ${root}`);
    }

    const totalBytes = await this.logger.span(
      'scan.walk',
      'Walking filesystem',
      () => this.measureDirectory(root, true),
      { root },
    );

    const candidateDirs = this.measuredDirectories
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
      const result: ScanCandidate = {
        ...classification,
        sizeBytes: candidate.sizeBytes,
      };
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
    const recoverableBytes = recoverableCandidates
      .reduce((sum, candidate) => sum + candidate.sizeBytes, 0);

    const safeCandidateCount = classifiedCandidates
      .filter((candidate) => candidate.classification === 'SAFE_CACHE').length;
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
      root,
      scannedFiles: this.scannedFiles,
      scannedDirectories: this.scannedDirectories,
      skippedEntries: this.skippedEntries,
      totalBytes,
      candidates: classifiedCandidates,
      recoverableBytes,
    };

    await this.logger.info('scan.complete', 'Scan completed', {
      root,
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

  private async measureDirectory(directoryPath: string, isRoot = false): Promise<number> {
    this.scannedDirectories += 1;
    let total = 0;

    let directory;
    try {
      directory = await opendir(directoryPath);
    } catch (error) {
      this.skippedEntries += 1;
      await this.logger.warn('scan.directory.skipped', 'Directory skipped due to access error', {
        path: directoryPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }

    for await (const entry of directory) {
      const fullPath = join(directoryPath, entry.name);

      try {
        if (entry.isSymbolicLink()) {
          this.skippedEntries += 1;
          await this.logger.debug('scan.symlink.skipped', 'Symbolic link skipped', { path: fullPath });
          continue;
        }

        if (entry.isDirectory()) {
          total += await this.measureDirectory(fullPath);
          continue;
        }

        if (entry.isFile()) {
          const stat = await lstat(fullPath);
          this.scannedFiles += 1;
          total += stat.size;
          continue;
        }

        this.skippedEntries += 1;
      } catch (error) {
        this.skippedEntries += 1;
        await this.logger.warn('scan.entry.skipped', 'Entry skipped due to error', {
          path: fullPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!isRoot) {
      this.measuredDirectories.push({ path: directoryPath, sizeBytes: total });
    }

    return total;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];

  for (let index = 0; index < units.length; index += 1) {
    unit = units[index];
    if (value < 1024 || index === units.length - 1) break;
    value /= 1024;
  }

  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

export function candidateLabel(path: string): string {
  return basename(path) || path;
}
