import { opendir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TraceLogger } from '../../observability/logger';

export interface DirectoryMeasure {
  path: string;
  sizeBytes: number;
}

export interface DirectoryMeasurementSummary {
  root: string;
  scannedFiles: number;
  scannedDirectories: number;
  skippedEntries: number;
  totalBytes: number;
  directories: DirectoryMeasure[];
}

export class DirectoryMeasurer {
  private scannedFiles = 0;
  private scannedDirectories = 0;
  private skippedEntries = 0;
  private readonly measuredDirectories: DirectoryMeasure[] = [];

  constructor(private readonly logger: TraceLogger) {}

  async measure(inputRoot: string): Promise<DirectoryMeasurementSummary> {
    const root = resolve(inputRoot);
    this.scannedFiles = 0;
    this.scannedDirectories = 0;
    this.skippedEntries = 0;
    this.measuredDirectories.length = 0;

    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) throw new Error(`Scan path is not a directory: ${root}`);

    const totalBytes = await this.logger.span(
      'scan.walk',
      'Walking filesystem',
      () => this.measureDirectory(root, true),
      { root },
    );

    return {
      root,
      scannedFiles: this.scannedFiles,
      scannedDirectories: this.scannedDirectories,
      skippedEntries: this.skippedEntries,
      totalBytes,
      directories: [...this.measuredDirectories],
    };
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

    if (!isRoot) this.measuredDirectories.push({ path: directoryPath, sizeBytes: total });
    return total;
  }
}
