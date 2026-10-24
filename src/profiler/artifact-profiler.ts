import { opendir, lstat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { TraceLogger } from '../observability/logger';

export interface ArtifactProfile {
  path: string;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  skippedEntries: number;
  newestMtimeMs: number | null;
  oldestMtimeMs: number | null;
  extensions: Array<{ extension: string; files: number; bytes: number }>;
}

export class ArtifactProfiler {
  constructor(private readonly logger: TraceLogger) {}

  async profile(inputPath: string): Promise<ArtifactProfile> {
    const root = resolve(inputPath);
    const rootStat = await lstat(root);

    if (rootStat.isSymbolicLink()) {
      throw new Error(`No se perfilan enlaces simbólicos: ${root}`);
    }

    if (rootStat.isFile()) {
      const extension = extname(root).toLowerCase() || '[sin extensión]';
      const profile: ArtifactProfile = {
        path: root,
        sizeBytes: rootStat.size,
        fileCount: 1,
        directoryCount: 0,
        skippedEntries: 0,
        newestMtimeMs: rootStat.mtimeMs,
        oldestMtimeMs: rootStat.mtimeMs,
        extensions: [{ extension, files: 1, bytes: rootStat.size }],
      };

      await this.logger.info('profile.complete', 'Perfil local generado', profile);
      return profile;
    }

    if (!rootStat.isDirectory()) {
      throw new Error(`La ruta a perfilar no es un archivo ni directorio regular: ${root}`);
    }

    let fileCount = 0;
    let directoryCount = 0;
    let skippedEntries = 0;
    let sizeBytes = 0;
    let newestMtimeMs: number | null = null;
    let oldestMtimeMs: number | null = null;
    const extensions = new Map<string, { files: number; bytes: number }>();

    const walk = async (directoryPath: string): Promise<void> => {
      directoryCount += 1;
      let directory;
      try {
        directory = await opendir(directoryPath);
      } catch (error) {
        skippedEntries += 1;
        await this.logger.warn('profile.directory.skipped', 'Directorio omitido durante el perfilado', {
          path: directoryPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      for await (const entry of directory) {
        const fullPath = join(directoryPath, entry.name);
        try {
          if (entry.isSymbolicLink()) {
            skippedEntries += 1;
            continue;
          }
          if (entry.isDirectory()) {
            await walk(fullPath);
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

          const extension = extname(entry.name).toLowerCase() || '[sin extensión]';
          const current = extensions.get(extension) ?? { files: 0, bytes: 0 };
          current.files += 1;
          current.bytes += stat.size;
          extensions.set(extension, current);
        } catch (error) {
          skippedEntries += 1;
          await this.logger.warn('profile.entry.skipped', 'Entrada omitida durante el perfilado', {
            path: fullPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    await this.logger.span('profile.walk', 'Perfilando artefacto local', () => walk(root), { root });

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
    };

    await this.logger.info('profile.complete', 'Perfil local generado', profile);
    return profile;
  }
}
