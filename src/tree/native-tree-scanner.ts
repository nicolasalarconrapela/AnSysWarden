import { createWriteStream } from 'node:fs';
import { lstat, mkdir, opendir, writeFile } from 'node:fs/promises';
import { hostname, platform } from 'node:os';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import {
  TREE_INDEX_SCHEMA,
  type TreeEntryType,
  type TreeIndexRecord,
  type TreeScanMetadata,
  type TreeScanOptions,
  type TreeScanProgress,
} from '../core/inventory/tree-types';

// Reexportación compatible para todos los consumidores existentes del módulo.
export {
  TREE_INDEX_SCHEMA,
  type TreeEntryType,
  type TreeEntryRecord,
  type TreeDirectorySummaryRecord,
  type TreeErrorRecord,
  type TreeIndexRecord,
  type TreeScanMetadata,
  type TreeScanOptions,
  type TreeScanProgress,
} from '../core/inventory/tree-types';

interface Aggregate {
  sizeBytes: number;
  files: number;
  directories: number;
  errors: number;
}

interface Counters {
  entries: number;
  files: number;
  directories: number;
  symlinks: number;
  others: number;
  errors: number;
}

export class NativeTreeScanner {
  private readonly stateDir: string;

  constructor(stateDir = resolve(process.cwd(), '.ansyswarden', 'tree')) {
    this.stateDir = stateDir;
  }

  async scan(inputPath: string, options: TreeScanOptions = {}): Promise<TreeScanMetadata> {
    const rootPath = resolveTreeInputPath(inputPath);
    // Validar la raíz ANTES de escribir un índice o actualizar latest.json.
    // Una ruta inválida no es un escaneo completado con 0 entradas.
    try {
      const rootStats = await lstat(rootPath);
      if (!rootStats.isDirectory()) {
        throw new Error(`La ruta no es una carpeta: "${rootPath}"`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new Error(
          `No se encontró la carpeta raíz (ENOENT).\n` +
          `Ruta recibida: "${inputPath}"\n` +
          `Ruta resuelta: "${rootPath}"\n` +
          'Desde Git Bash en Windows, utiliza por ejemplo: ' +
          './ansys-tree scan "C:/Users/nalar/Desktop" --html escritorio.html'
        );
      }
      throw error;
    }

    const id = createTreeScanId();
    const scansDir = join(this.stateDir, 'scans');
    await mkdir(scansDir, { recursive: true });

    const indexPath = resolve(options.outputPath ?? join(scansDir, `${id}.jsonl`));
    await mkdir(dirname(indexPath), { recursive: true });

    const output = createWriteStream(indexPath, { encoding: 'utf8', flags: 'w' });
    const counters: Counters = {
      entries: 0,
      files: 0,
      directories: 0,
      symlinks: 0,
      others: 0,
      errors: 0,
    };
    const progressEvery = Math.max(1, options.progressEvery ?? 5_000);

    const writeRecord = async (record: TreeIndexRecord): Promise<void> => {
      if (!output.write(`${JSON.stringify(record)}\n`)) await once(output, 'drain');
    };

    const emitProgress = (currentPath: string): void => {
      if (!options.onProgress || counters.entries % progressEvery !== 0) return;
      options.onProgress({
        entries: counters.entries,
        files: counters.files,
        directories: counters.directories,
        errors: counters.errors,
        currentPath,
      });
    };

    const recordError = async (
      path: string,
      parentPath: string | undefined,
      depth: number,
      error: unknown,
    ): Promise<void> => {
      counters.errors += 1;
      const nodeError = error as NodeJS.ErrnoException;
      await writeRecord({
        record: 'error',
        path,
        ...(parentPath === undefined ? {} : { parentPath }),
        name: basename(path) || path,
        depth,
        ...(nodeError?.code ? { code: nodeError.code } : {}),
        message: error instanceof Error ? error.message : String(error),
      });
    };

    const walk = async (path: string, parentPath: string | undefined, depth: number): Promise<Aggregate> => {
      let stats;
      try {
        stats = await lstat(path);
      } catch (error) {
        await recordError(path, parentPath, depth, error);
        return { sizeBytes: 0, files: 0, directories: 0, errors: 1 };
      }

      const type: TreeEntryType = stats.isSymbolicLink()
        ? 'symlink'
        : stats.isDirectory()
          ? 'directory'
          : stats.isFile()
            ? 'file'
            : 'other';

      counters.entries += 1;
      if (type === 'directory') counters.directories += 1;
      else if (type === 'file') counters.files += 1;
      else if (type === 'symlink') counters.symlinks += 1;
      else counters.others += 1;

      await writeRecord({
        record: 'entry',
        path,
        ...(parentPath === undefined ? {} : { parentPath }),
        name: basename(path) || path,
        type,
        depth,
        sizeBytes: type === 'directory' ? 0 : Math.max(0, stats.size),
        mtimeMs: stats.mtimeMs,
        atimeMs: stats.atimeMs,
        birthtimeMs: stats.birthtimeMs,
      });
      emitProgress(path);

      if (type !== 'directory') {
        const files = type === 'file' ? 1 : 0;
        return { sizeBytes: Math.max(0, stats.size), files, directories: 0, errors: 0 };
      }

      let aggregate: Aggregate = { sizeBytes: 0, files: 0, directories: 0, errors: 0 };
      let directory;
      try {
        directory = await opendir(path);
      } catch (error) {
        await recordError(path, parentPath, depth, error);
        aggregate.errors += 1;
        await writeRecord({ record: 'directory-summary', path, ...aggregate });
        return aggregate;
      }

      try {
        for await (const child of directory) {
          const childPath = join(path, child.name);
          const childAggregate = await walk(childPath, path, depth + 1);
          aggregate = {
            sizeBytes: aggregate.sizeBytes + childAggregate.sizeBytes,
            files: aggregate.files + childAggregate.files,
            directories: aggregate.directories + childAggregate.directories + (child.isDirectory() ? 1 : 0),
            errors: aggregate.errors + childAggregate.errors,
          };
        }
      } catch (error) {
        await recordError(path, parentPath, depth, error);
        aggregate.errors += 1;
      }

      await writeRecord({ record: 'directory-summary', path, ...aggregate });
      return aggregate;
    };

    let rootAggregate: Aggregate;
    try {
      rootAggregate = await walk(rootPath, undefined, 0);
    } finally {
      output.end();
      await once(output, 'finish');
    }

    const metadata: TreeScanMetadata = {
      schema: TREE_INDEX_SCHEMA,
      id,
      createdAt: new Date().toISOString(),
      rootPath,
      computer: hostname(),
      platform: platform(),
      indexPath,
      entries: counters.entries,
      files: counters.files,
      directories: counters.directories,
      symlinks: counters.symlinks,
      others: counters.others,
      errors: counters.errors,
      sizeBytes: rootAggregate.sizeBytes,
    };

    const metadataPath = join(scansDir, `${id}.meta.json`);
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await writeFile(join(this.stateDir, 'latest.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

    return metadata;
  }
}

function createTreeScanId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `tree-${timestamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * Acepta rutas nativas de Windows y rutas habituales de Git Bash/Cygwin/WSL.
 * No intenta reconstruir rutas mal citadas que hayan perdido los separadores.
 */
export function resolveTreeInputPath(inputPath: string): string {
  if (!inputPath || !inputPath.trim()) throw new Error('Debes indicar una carpeta para escanear.');
  if (platform() !== 'win32') {
    if (/^[A-Za-z]:/.test(inputPath)) {
      throw new Error('Esta sesión de Node no está ejecutándose en Windows. Utiliza una ruta de este entorno.');
    }
    return resolve(inputPath);
  }

  if (/^[A-Za-z]:(?![\\/])/.test(inputPath)) {
    throw new Error(
      `Ruta de Windows ambigua: "${inputPath}". Usa barras / y ruta absoluta, por ejemplo C:/Users/nalar/Desktop.`
    );
  }

  const unixDrive = inputPath.match(/^\/(?:cygdrive\/|mnt\/)?([A-Za-z])(?:\/(.*))?$/);
  if (unixDrive) {
    const drive = unixDrive[1].toUpperCase();
    const rest = unixDrive[2] ?? '';
    return win32.resolve(`${drive}:/${rest}`);
  }

  return win32.resolve(inputPath);
}
