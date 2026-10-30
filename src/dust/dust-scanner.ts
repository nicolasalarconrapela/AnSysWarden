import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { AiTreePruner } from '../ai/tree-pruner';
import type { AiInputDocument } from '../ai/tree-types';
import { BackendStorage } from '../backend/storage';
import { SCAN_SCHEMA, type ScanDocument, type ScanEntry } from '../backend/types';
import { resolveDustBin } from './dust-path';

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_DEPTH = 5;
const DEFAULT_MIN_SIZE = '50M';
const MAX_ENTRIES = 100_000;

interface DustJsonNode {
  size: string | number;
  name: string;
  children: DustJsonNode[];
}

export interface DustScanOptions {
  depth?: number;
  minSize?: string;
  aiTreeDepth?: number;
  aiTreeMaxEntries?: number;
}

export interface DustScanResult {
  scan: ScanDocument;
  aiInput: AiInputDocument;
  filePath: string;
  aiInputPath: string;
  depth: number;
  minSize: string;
}

export class DustScanner {
  private readonly storage: BackendStorage;
  private readonly maxOutputBytes: number;
  private readonly treePruner: AiTreePruner;

  constructor(storage = new BackendStorage(), treePruner = new AiTreePruner()) {
    this.storage = storage;
    this.treePruner = treePruner;
    this.maxOutputBytes = readPositiveInt(
      process.env.ANSYSWARDEN_DUST_MAX_OUTPUT_BYTES,
      DEFAULT_MAX_OUTPUT_BYTES,
    );
  }

  getBinary(): { path: string; source: 'env' | 'managed' | 'path' } {
    return resolveDustBin();
  }

  async version(): Promise<string> {
    const bin = this.getBinary();
    const result = await runProcess(bin.path, ['--version'], 1024 * 1024);
    return result.stdout.trim();
  }

  async scan(inputPath: string, options: DustScanOptions = {}): Promise<DustScanResult> {
    const depth = options.depth ?? readPositiveInt(process.env.ANSYSWARDEN_DUST_DEPTH, DEFAULT_DEPTH);
    if (!Number.isInteger(depth) || depth < 1 || depth > 32) {
      throw new Error(`Invalid Dust depth: ${depth}. It must be between 1 and 32.`);
    }

    const minSize = options.minSize ?? process.env.ANSYSWARDEN_DUST_MIN_SIZE ?? DEFAULT_MIN_SIZE;
    if (!/^[0-9]+(?:\.[0-9]+)?(?:B|K|KB|KIB|M|MB|MIB|G|GB|GIB|T|TB|TIB)?$/i.test(minSize)) {
      throw new Error(`Invalid Dust minimum size: ${minSize}`);
    }

    const target = resolve(inputPath);
    // AnSysWarden makes decisions about directories. -D prevents isolated large
    // files (VHDX, installers, SQLite databases...) from becoming Gemma candidates.
    const args = ['-j', '-p', '-P', '-D', '-o', 'b', '-d', String(depth), '-z', minSize, target];
    const bin = this.getBinary();
    const result = await runProcess(bin.path, args, this.maxOutputBytes);

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Dust returned invalid JSON: ${reason}`);
    }

    const root = parseDustNode(parsed);
    const entries = flattenDustTree(root);
    if (entries.length === 0) {
      throw new Error('Dust returned no usable scan entries.');
    }

    const scan: ScanDocument = {
      schema: SCAN_SCHEMA,
      id: createScanId(),
      createdAt: new Date().toISOString(),
      source: 'dust',
      computer: hostname(),
      entries,
    };

    // The Dust scan is the complete source of directory sizes. The AI tree is
    // derived afterwards and never replaces or modifies the original inventory.
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
    };
  }
}

function parseDustNode(value: unknown): DustJsonNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Dust JSON root does not have the expected format.');
  }

  const node = value as Record<string, unknown>;
  if (typeof node.name !== 'string' || node.name.length === 0) {
    throw new Error('Dust returned a node without a valid name.');
  }
  if (!(typeof node.size === 'string' || typeof node.size === 'number')) {
    throw new Error(`Dust returned an invalid size for ${node.name}.`);
  }
  if (!Array.isArray(node.children)) {
    throw new Error(`Dust returned invalid children for ${node.name}.`);
  }

  return {
    name: node.name,
    size: node.size,
    children: node.children.map(parseDustNode),
  };
}

function flattenDustTree(root: DustJsonNode): ScanEntry[] {
  const entries = new Map<string, ScanEntry>();

  const visit = (node: DustJsonNode, parentId: string | undefined, depth: number): void => {
    let currentParentId = parentId;

    if (node.name !== '(total)') {
      const entryId = createEntryId(node.name);
      entries.set(node.name, {
        entryId,
        ...(parentId === undefined ? {} : { parentId }),
        depth,
        path: node.name,
        sizeBytes: parseDustSize(node.size),
      });
      currentParentId = entryId;

      if (entries.size > MAX_ENTRIES) {
        throw new Error(`Dust produced more than ${MAX_ENTRIES} entries; reduce --depth or increase --min-size.`);
      }
    }

    const childDepth = node.name === '(total)' ? depth : depth + 1;
    for (const child of node.children) visit(child, currentParentId, childDepth);
  };

  visit(root, undefined, 0);
  return [...entries.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function createEntryId(path: string): string {
  return `entry-${createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 16)}`;
}

export function parseDustSize(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid Dust size: ${value}`);
    return Math.round(value);
  }

  const normalized = value.trim().replace(/,/g, '');
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB|TB|TIB|PB|PIB|K|KI|M|MI|G|GI|T|TI|P|PI)?$/i);
  if (!match) throw new Error(`Could not parse Dust size: ${value}`);

  const amount = Number(match[1]);
  const unit = (match[2] ?? 'B').toUpperCase();
  const factors: Record<string, number> = {
    B: 1,
    K: 1000,
    KB: 1000,
    M: 1000 ** 2,
    MB: 1000 ** 2,
    G: 1000 ** 3,
    GB: 1000 ** 3,
    T: 1000 ** 4,
    TB: 1000 ** 4,
    P: 1000 ** 5,
    PB: 1000 ** 5,
    KI: 1024,
    KIB: 1024,
    MI: 1024 ** 2,
    MIB: 1024 ** 2,
    GI: 1024 ** 3,
    GIB: 1024 ** 3,
    TI: 1024 ** 4,
    TIB: 1024 ** 4,
    PI: 1024 ** 5,
    PIB: 1024 ** 5,
  };

  const factor = factors[unit];
  if (!factor) throw new Error(`Unsupported Dust size unit: ${unit}`);
  return Math.round(amount * factor);
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

function runProcess(bin: string, args: string[], maxOutputBytes: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        child.kill();
        fail(new Error(`Dust JSON output exceeds the maximum allowed ${maxOutputBytes} bytes.`));
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 1024 * 1024) return;
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        fail(new Error(`'${bin}' was not found. Run: ./ansys dust install`));
        return;
      }
      fail(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      const errText = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        fail(new Error(`Dust exited with code ${String(code)}${errText ? `: ${errText}` : ''}`));
        return;
      }
      settled = true;
      resolvePromise({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: errText,
      });
    });
  });
}
