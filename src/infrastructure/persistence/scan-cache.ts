import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isScanDocument, type ScanDocument } from '../../core/contracts/backend-protocol';

const CACHE_SCHEMA = 'ansyswarden.scan-cache.v1' as const;

export interface CachedScanMetadata {
  schema: typeof CACHE_SCHEMA;
  scanId: string;
  cachedAt: string;
  backendUrl: string;
  sha256: string;
  entries: number;
  createdAt: string;
  source: string;
  computer: string;
}

export interface CachedScan {
  metadata: CachedScanMetadata;
  scan: ScanDocument;
  scanPath: string;
  metadataPath: string;
}

export class ScanCache {
  readonly root: string;

  constructor(root = process.env.ANSYSWARDEN_SCAN_CACHE_DIR ?? join(homedir(), '.ansyswarden', 'cache', 'scans')) {
    this.root = resolve(root);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async save(scan: ScanDocument, backendUrl: string): Promise<CachedScan> {
    await this.init();
    const scanPath = join(this.root, `${scan.id}.json`);
    const metadataPath = join(this.root, `${scan.id}.meta.json`);
    const payload = `${JSON.stringify(scan, null, 2)}\n`;
    const metadata: CachedScanMetadata = {
      schema: CACHE_SCHEMA,
      scanId: scan.id,
      cachedAt: new Date().toISOString(),
      backendUrl,
      sha256: createHash('sha256').update(payload).digest('hex'),
      entries: scan.entries.length,
      createdAt: scan.createdAt,
      source: scan.source,
      computer: scan.computer,
    };

    await atomicWrite(scanPath, payload);
    await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return { metadata, scan, scanPath, metadataPath };
  }

  async get(scanId: string): Promise<CachedScan | null> {
    const scanPath = join(this.root, `${scanId}.json`);
    const metadataPath = join(this.root, `${scanId}.meta.json`);

    try {
      const [scanRaw, metadataRaw] = await Promise.all([
        readFile(scanPath, 'utf8'),
        readFile(metadataPath, 'utf8'),
      ]);
      const scan = JSON.parse(scanRaw) as unknown;
      const metadata = JSON.parse(metadataRaw) as unknown;
      if (!isScanDocument(scan) || !isCachedScanMetadata(metadata)) return null;

      const expectedHash = createHash('sha256').update(scanRaw).digest('hex');
      if (metadata.sha256 !== expectedHash || metadata.scanId !== scan.id) {
        throw new Error(`Cached scan ${scanId} failed integrity verification.`);
      }

      return { metadata, scan, scanPath, metadataPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(): Promise<CachedScanMetadata[]> {
    await this.init();
    const files = (await readdir(this.root)).filter((name) => name.endsWith('.meta.json'));
    const rows: CachedScanMetadata[] = [];

    for (const file of files) {
      try {
        const value = JSON.parse(await readFile(join(this.root, file), 'utf8')) as unknown;
        if (isCachedScanMetadata(value)) rows.push(value);
      } catch {
        // Ignore malformed cache metadata; `show`/`get` performs strict validation.
      }
    }

    return rows.sort((a, b) => b.cachedAt.localeCompare(a.cachedAt));
  }

  async delete(scanId: string): Promise<boolean> {
    const scanPath = join(this.root, `${scanId}.json`);
    const metadataPath = join(this.root, `${scanId}.meta.json`);
    let removed = false;

    for (const path of [scanPath, metadataPath]) {
      try {
        await unlink(path);
        removed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    return removed;
  }

  async deleteAll(): Promise<number> {
    const rows = await this.list();
    let removed = 0;
    for (const row of rows) {
      if (await this.delete(row.scanId)) removed += 1;
    }
    return removed;
  }
}

function isCachedScanMetadata(value: unknown): value is CachedScanMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema === CACHE_SCHEMA
    && typeof record.scanId === 'string'
    && typeof record.cachedAt === 'string'
    && !Number.isNaN(Date.parse(record.cachedAt))
    && typeof record.backendUrl === 'string'
    && typeof record.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(record.sha256)
    && Number.isInteger(record.entries)
    && Number(record.entries) >= 0
    && typeof record.createdAt === 'string'
    && typeof record.source === 'string'
    && typeof record.computer === 'string';
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
  await rename(temp, path);
}
