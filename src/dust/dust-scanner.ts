import { randomUUID } from 'node:crypto';
import { hostname, platform } from 'node:os';
import { resolve, join } from 'node:path';
import { AiTreePruner } from '../ai/tree-pruner';
import type { AiInputDocument } from '../ai/tree-types';
import { BackendStorage } from '../backend/storage';
import { SCAN_SCHEMA, type ScanDeviceRole, type ScanDocument } from '../backend/types';
import { DustAdapter } from '../infrastructure/dust/dust-adapter';

const DEFAULT_DEPTH = 5;
const DEFAULT_MIN_SIZE = '50M';
const FULL_DEPTH = 32;
const FULL_MIN_SIZE = '0B';
const FULL_MAX_ENTRIES = 100_000;
const FULL_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export interface DustScanOptions {
  depth?: number;
  minSize?: string;
  aiTreeDepth?: number;
  aiTreeMaxEntries?: number;
  full?: boolean;
}

export interface DustScanResult {
  scan: ScanDocument;
  aiInput: AiInputDocument;
  filePath: string;
  aiInputPath: string;
  depth: number;
  minSize: string;
  full: boolean;
}

export class DustScanner {
  private readonly storage: BackendStorage;
  private readonly treePruner: AiTreePruner;
  private readonly adapter: DustAdapter;

  constructor(
    storage = new BackendStorage(),
    treePruner = new AiTreePruner(),
    adapter = new DustAdapter(),
  ) {
    this.storage = storage;
    this.treePruner = treePruner;
    this.adapter = adapter;
  }

  getBinary(): { path: string; source: 'env' | 'managed' | 'path' } {
    return this.adapter.getBinary();
  }

  async version(): Promise<string> {
    return this.adapter.version();
  }

  async scan(inputPath: string, options: DustScanOptions = {}): Promise<DustScanResult> {
    const full = options.full === true;
    const depth = full
      ? options.depth ?? FULL_DEPTH
      : options.depth ?? readPositiveInt(process.env.ANSYSWARDEN_DUST_DEPTH, DEFAULT_DEPTH);

    if (!Number.isInteger(depth) || depth < 1 || depth > 32) {
      throw new Error(`Invalid Dust depth: ${depth}. It must be between 1 and 32.`);
    }

    const minSize = full
      ? options.minSize ?? FULL_MIN_SIZE
      : options.minSize ?? process.env.ANSYSWARDEN_DUST_MIN_SIZE ?? DEFAULT_MIN_SIZE;

    if (!/^[0-9]+(?:\.[0-9]+)?(?:B|K|KB|KIB|M|MB|MIB|G|GB|GIB|T|TB|TIB)?$/i.test(minSize)) {
      throw new Error(`Invalid Dust minimum size: ${minSize}`);
    }

    const target = resolve(inputPath);
    const { entries } = await this.adapter.execute({
      depth,
      minSize,
      target,
      ...(full ? {
        maxDisplayedEntries: FULL_MAX_ENTRIES,
        maxEntries: FULL_MAX_ENTRIES,
        maxOutputBytes: FULL_MAX_OUTPUT_BYTES,
      } : {}),
    });
    const currentHostname = hostname();

    const scan: ScanDocument = {
      schema: SCAN_SCHEMA,
      id: createScanId(),
      createdAt: new Date().toISOString(),
      source: 'dust',
      computer: currentHostname,
      origin: {
        deviceRole: detectDeviceRole(),
        platform: detectPlatformLabel(),
        scanner: 'dust',
        rootPath: target,
        hostname: currentHostname,
      },
      entries,
    };

    await this.storage.saveScan(scan);
    const aiInput = await this.treePruner.build(scan, target, {
      ...(options.aiTreeDepth === undefined ? {} : { maxDepth: options.aiTreeDepth }),
      ...(options.aiTreeMaxEntries === undefined ? {} : { maxEntries: options.aiTreeMaxEntries }),
    });
    await this.storage.saveAiInput(aiInput);

    return {
      scan,
      aiInput,
      filePath: join(this.storage.scansDir, `${scan.id}.json`),
      aiInputPath: join(this.storage.aiInputsDir, `${scan.id}.ai.json`),
      depth,
      minSize,
      full,
    };
  }
}

export { parseDustSize } from '../infrastructure/dust/dust-adapter';

function detectDeviceRole(): ScanDeviceRole {
  if (process.env.TERMUX_VERSION || process.env.PREFIX?.includes('com.termux')) return 'mobile';
  if (platform() === 'android') return 'mobile';
  if (platform() === 'win32' || platform() === 'darwin' || platform() === 'linux') return 'pc';
  return 'other';
}

function detectPlatformLabel(): string {
  if (process.env.TERMUX_VERSION || process.env.PREFIX?.includes('com.termux')) return 'android-termux';
  return platform();
}

function createScanId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `dust-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
