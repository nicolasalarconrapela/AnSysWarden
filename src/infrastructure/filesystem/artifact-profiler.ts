import { opendir, lstat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { TraceLogger } from '../../observability/logger';

export type ProfileLimitReason = 'MAX_FILES' | 'MAX_DIRECTORIES' | 'MAX_DURATION';

export interface ArtifactProfile {
  path: string;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  skippedEntries: number;
  newestMtimeMs: number | null;
  oldestMtimeMs: number | null;
  extensions: Array<{ extension: string; files: number; bytes: number }>;
  profileComplete?: boolean;
  limitReason?: ProfileLimitReason | null;
}

export interface ArtifactProfilerOptions {
  maxFiles?: number;
  maxDirectories?: number;
  maxDurationMs?: number;
}

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_DIRECTORIES = 5_000;
const DEFAULT_MAX_DURATION_MS = 5_000;

function toLogMetadata(profile: ArtifactProfile): Record<string, unknown> {
  return {
    path: profile.path,
    sizeBytes: profile.sizeBytes,
    fileCount: profile.fileCount,
    directoryCount: profile.directoryCount,
    skippedEntries: profile.skippedEntries,
    newestMtimeMs: profile.newestMtimeMs,
    oldestMtimeMs: profile.oldestMtimeMs,
    extensions: profile.extensions,
    profileComplete: profile.profileComplete ?? null,
    limitReason: profile.limitReason ?? null,
  };
}

export class ArtifactProfiler {
  constructor(
    private readonly logger: TraceLogger,
    private readonly options: ArtifactProfilerOptions = {},
  ) {}

  async profile(inputPath: string): Promise<ArtifactProfile> {
    const root = resolve(inputPath);
    const rootStat = await lstat(root);
    const maxFiles = this.options.maxFiles ?? DEFAULT_MAX_FILES;
    const maxDirectories = this.options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
    const maxDurationMs = this.options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

    if (rootStat.isSymbolicLink()) throw new Error(`Symbolic links are not profiled: ${root}`);

    if (rootStat.isFile()) {
      const extension = extname(root).toLowerCase() || '[no extension]';
      const profile: ArtifactProfile = {
        path: root,
        sizeBytes: rootStat.size,
        fileCount: 1,
        directoryCount: 0,
        skippedEntries: 0,
        newestMtimeMs: rootStat.mtimeMs,
        oldestMtimeMs: rootStat.mtimeMs,
        extensions: [{ extension, files: 1, bytes: rootStat.size }],
        profileComplete: true,
        limitReason: null,
      };
      await this.logger.info('profile.complete', 'Local artifact profile generated', toLogMetadata(profile));
      return profile;
    }

    if (!rootStat.isDirectory()) {
      throw new Error(`The path to profile is not a regular file or directory: ${root}`);
    }

    let fileCount = 0;
    let directoryCount = 0;
    let skippedEntries = 0;
    let sizeBytes = 0;
    let newestMtimeMs: number | null = null;
    let oldestMtimeMs: number | null = null;
    let limitReason: ProfileLimitReason | null = null;
    const extensions = new Map<string, { files: number; bytes: number }>();
    const startedAt = performance.now();

    const markLimit = async (reason: ProfileLimitReason, atPath: string): Promise<void> => {
      if (limitReason) return;
      limitReason = reason;
      await this.logger.warn('profile.limit_reached', 'Profiling stopped by the safety budget', {
        root,
        at_path: atPath,
        limit_reason: reason,
        max_files: maxFiles,
        max_directories: maxDirectories,
        max_duration_ms: maxDurationMs,
        observed_files: fileCount,
        observed_directories: directoryCount,
      });
    };

    const shouldStop = async (atPath: string): Promise<boolean> => {
      if (limitReason) return true;
      if (fileCount >= maxFiles) {
        await markLimit('MAX_FILES', atPath);
        return true;
      }
      if (directoryCount >= maxDirectories) {
        await markLimit('MAX_DIRECTORIES', atPath);
        return true;
      }
      if (performance.now() - startedAt >= maxDurationMs) {
        await markLimit('MAX_DURATION', atPath);
        return true;
      }
      return false;
    };

    const walk = async (directoryPath: string): Promise<void> => {
      if (await shouldStop(directoryPath)) return;
      directoryCount += 1;

      let directory;
      try {
        directory = await opendir(directoryPath);
      } catch (error) {
        skippedEntries += 1;
        await this.logger.warn('profile.directory.skipped', 'Directory skipped while profiling', {
          path: directoryPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      for await (const entry of directory) {
        const fullPath = join(directoryPath, entry.name);
        if (await shouldStop(fullPath)) break;

        try {
          if (entry.isSymbolicLink()) {
            skippedEntries += 1;
            continue;
          }
          if (entry.isDirectory()) {
            await walk(fullPath);
            if (limitReason) break;
            continue;
          }
          if (!entry.isFile()) {
            skippedEntries += 1;
            continue;
          }

          const stat = await lstat(fullPath);
          fileCount += 1;
          sizeBytes += stat.size;
          newestMtimeMs = newestMtimeMs === null ? stat.mtimeMs : Math.max(newestMtimeMs, stat.mtimeMs);
          oldestMtimeMs = oldestMtimeMs === null ? stat.mtimeMs : Math.min(oldestMtimeMs, stat.mtimeMs);

          const extension = extname(entry.name).toLowerCase() || '[no extension]';
          const current = extensions.get(extension) ?? { files: 0, bytes: 0 };
          current.files += 1;
          current.bytes += stat.size;
          extensions.set(extension, current);
        } catch (error) {
          skippedEntries += 1;
          await this.logger.warn('profile.entry.skipped', 'Entry skipped while profiling', {
            path: fullPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    await this.logger.span('profile.walk', 'Profiling local artifact', () => walk(root), {
      root,
      max_files: maxFiles,
      max_directories: maxDirectories,
      max_duration_ms: maxDurationMs,
    });

    const extensionRows = [...extensions.entries()]
      .map(([extension, value]) => ({ extension, ...value }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 12);

    const profile: ArtifactProfile = {
      path: root,
      sizeBytes,
      fileCount,
      directoryCount,
      skippedEntries,
      newestMtimeMs,
      oldestMtimeMs,
      extensions: extensionRows,
      profileComplete: limitReason === null,
      limitReason,
    };

    await this.logger.info('profile.complete', 'Local artifact profile generated', toLogMetadata(profile));
    return profile;
  }
}
