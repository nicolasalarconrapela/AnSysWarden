import { createWriteStream } from 'node:fs';
import { lstat, mkdir, opendir, writeFile } from 'node:fs/promises';
import { hostname, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

export const TREE_INDEX_SCHEMA = 'ansyswarden.tree-index.v1' as const;

export type TreeEntryType = 'directory' | 'file' | 'symlink' | 'other';

export interface TreeEntryRecord {
  record: 'entry';
  path: string;
  parentPath?: string;
  name: string;
  type: TreeEntryType;
  depth: number;
  sizeBytes: number;
  mtimeMs: number;
  atimeMs: number;
}

export interface TreeDirectorySummaryRecord {
  record: 'directory-summary';
  path: string;
  sizeBytes: number;
  files: number;
  directories: number;
  errors: number;
}

export interface TreeErrorRecord {
  record: 'error';
  path: string;
  parentPath?: string;
  name: string;
  depth: number;
  code?: string;
  message: string;
}

export type TreeIndexRecord = TreeEntryRecord | TreeDirectorySummaryRecord | TreeErrorRecord;

export interface TreeScanMetadata {
  schema: typeof TREE_INDEX_SCHEMA;
  id: string;
  createdAt: string;
  rootPath: string;
  computer: string;
  platform: string;
  indexPath: string;
  entries: number;
  files: number;
  directories: number;
  symlinks: number;
  others: number;
  errors: number;
  sizeBytes: number;
}

export interface TreeScanOptions {
  outputPath?: string;
  onProgress?: (progress: TreeScanProgress) => void;
  progressEvery?: number;
}

export interface TreeScanProgress {
  entries: number;
  files: number;
  directories: number;
  errors: number;
  currentPath: string;
}

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
    const rootPath = resolve(inputPath);
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
