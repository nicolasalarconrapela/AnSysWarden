import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ScanDocument, ScanResultDocument } from './types';

export class BackendStorage {
  readonly root: string;
  readonly scansDir: string;
  readonly resultsDir: string;

  constructor(root = process.env.ANSYSWARDEN_BACKEND_DATA_DIR ?? '.ansyswarden/backend/data') {
    this.root = resolve(root);
    this.scansDir = join(this.root, 'scans');
    this.resultsDir = join(this.root, 'results');
  }

  async init(): Promise<void> {
    await mkdir(this.scansDir, { recursive: true });
    await mkdir(this.resultsDir, { recursive: true });
  }

  async saveScan(scan: ScanDocument): Promise<void> {
    await this.init();
    await atomicWriteJson(join(this.scansDir, `${scan.id}.json`), scan);
    await atomicWriteJson(join(this.scansDir, 'latest.json'), scan);
  }

  async getScan(id: string): Promise<ScanDocument | null> {
    return readJsonOrNull<ScanDocument>(join(this.scansDir, `${id}.json`));
  }

  async getLatestScan(): Promise<ScanDocument | null> {
    return readJsonOrNull<ScanDocument>(join(this.scansDir, 'latest.json'));
  }

  async listScans(): Promise<Array<{ id: string; createdAt: string; source: string; computer: string; entries: number }>> {
    await this.init();
    const files = (await readdir(this.scansDir)).filter((name) => name.endsWith('.json') && name !== 'latest.json');
    const rows = [];
    for (const file of files) {
      const scan = await readJsonOrNull<ScanDocument>(join(this.scansDir, file));
      if (!scan) continue;
      rows.push({ id: scan.id, createdAt: scan.createdAt, source: scan.source, computer: scan.computer, entries: scan.entries.length });
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveResult(result: ScanResultDocument): Promise<void> {
    await this.init();
    await atomicWriteJson(join(this.resultsDir, `${result.scanId}.result.json`), result);
  }

  async getResult(scanId: string): Promise<ScanResultDocument | null> {
    return readJsonOrNull<ScanResultDocument>(join(this.resultsDir, `${scanId}.result.json`));
  }
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temp, path);
}
