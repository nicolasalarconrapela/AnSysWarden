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
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isDescendantPath(parent: string, child: string): boolean {
  const normalizedParent = normalizedOverlapPath(parent);
  const normalizedChild = normalizedOverlapPath(child);
  return normalizedChild !== normalizedParent && normalizedChild.startsWith(`${normalizedParent}/`);
}

export function removeOverlappingSafeCandidates(candidates: ScanCandidate[]): ScanCandidate[] {
  const safeCandidates = candidates
    .filter((candidate) => candidate.classification === 'SAFE_CACHE')
    .sort((a, b) => normalizedOverlapPath(a.path).length - normalizedOverlapPath(b.path).length);

  const keptSafePaths: string[] = [];
  for (const candidate of safeCandidates) {
    const normalized = normalizedOverlapPath(candidate.path);
    const alreadyCovered = keptSafePaths.some(
      (parent) => parent === normalized || isDescendantPath(parent, normalized),
    );
    if (!alreadyCovered) keptSafePaths.push(normalized);
  }

  return candidates.filter((candidate) => {
    if (candidate.classification !== 'SAFE_CACHE') return true;
    return keptSafePaths.includes(normalizedOverlapPath(candidate.path));
  });
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

    await this.logger.info('scan.config', 'Configuración del escaneo', {
      root,
      min_bytes: minBytes,
      max_candidates: maxCandidates,
      follow_symlinks: false,
      destructive_actions: false,
    });

    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) {
      throw new Error(`La ruta de escaneo no es un directorio: ${root}`);
    }

    const totalBytes = await this.logger.span(
      'scan.walk',
      'Recorriendo sistema de archivos',
      () => this.measureDirectory(root, true),
      { root },
    );

    const candidateDirs = this.measuredDirectories
      .filter((entry) => entry.sizeBytes >= minBytes)
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .slice(0, maxCandidates);

    await this.logger.info('scan.candidates', 'Candidatos detectados', {
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
      await this.logger.info('scan.candidate.result', 'Candidato clasificado', {
        path: result.path,
        size_bytes: result.sizeBytes,
        classification: result.classification,
        confidence: result.confidence,
        source: result.source,
        reason: result.reason,
      });
    }

    const candidates = removeOverlappingSafeCandidates(classifiedCandidates);
    const removedOverlaps = classifiedCandidates.length - candidates.length;
    if (removedOverlaps > 0) {
      await this.logger.info('scan.overlap.filtered', 'Candidatos SAFE_CACHE solapados omitidos', {
        removed_count: removedOverlaps,
      });
    }

    const recoverableBytes = candidates
      .filter((candidate) => candidate.classification === 'SAFE_CACHE')
      .reduce((sum, candidate) => sum + candidate.sizeBytes, 0);

    const summary: ScanSummary = {
      root,
      scannedFiles: this.scannedFiles,
      scannedDirectories: this.scannedDirectories,
      skippedEntries: this.skippedEntries,
      totalBytes,
      candidates,
      recoverableBytes,
    };

    await this.logger.info('scan.complete', 'Escaneo completado', {
      root,
      scanned_files: summary.scannedFiles,
      scanned_directories: summary.scannedDirectories,
      skipped_entries: summary.skippedEntries,
      total_bytes: summary.totalBytes,
      candidate_count: summary.candidates.length,
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
      await this.logger.warn('scan.directory.skipped', 'Directorio omitido por error de acceso', {
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
          await this.logger.debug('scan.symlink.skipped', 'Enlace simbólico omitido', { path: fullPath });
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
        await this.logger.warn('scan.entry.skipped', 'Entrada omitida por error', {
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
