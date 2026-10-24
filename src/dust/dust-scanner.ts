import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { BackendStorage } from '../backend/storage';
import { SCAN_SCHEMA, type ScanDocument, type ScanEntry } from '../backend/types';

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
}

export interface DustScanResult {
  scan: ScanDocument;
  filePath: string;
  depth: number;
  minSize: string;
}

export class DustScanner {
  private readonly bin: string;
  private readonly storage: BackendStorage;
  private readonly maxOutputBytes: number;

  constructor(storage = new BackendStorage()) {
    this.storage = storage;
    this.bin = process.env.ANSYSWARDEN_DUST_BIN?.trim() || 'dust';
    this.maxOutputBytes = readPositiveInt(
      process.env.ANSYSWARDEN_DUST_MAX_OUTPUT_BYTES,
      DEFAULT_MAX_OUTPUT_BYTES,
    );
  }

  async version(): Promise<string> {
    const result = await runProcess(this.bin, ['--version'], 1024 * 1024);
    return result.stdout.trim();
  }

  async scan(inputPath: string, options: DustScanOptions = {}): Promise<DustScanResult> {
    const depth = options.depth ?? readPositiveInt(process.env.ANSYSWARDEN_DUST_DEPTH, DEFAULT_DEPTH);
    if (!Number.isInteger(depth) || depth < 1 || depth > 32) {
      throw new Error(`Profundidad Dust inválida: ${depth}. Debe estar entre 1 y 32.`);
    }

    const minSize = options.minSize ?? process.env.ANSYSWARDEN_DUST_MIN_SIZE ?? DEFAULT_MIN_SIZE;
    if (!/^[0-9]+(?:\.[0-9]+)?(?:B|K|KB|KIB|M|MB|MIB|G|GB|GIB|T|TB|TIB)?$/i.test(minSize)) {
      throw new Error(`Tamaño mínimo Dust inválido: ${minSize}`);
    }

    const target = resolve(inputPath);
    const args = ['-j', '-p', '-P', '-o', 'b', '-d', String(depth), '-z', minSize, target];
    const result = await runProcess(this.bin, args, this.maxOutputBytes);

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Dust devolvió JSON inválido: ${reason}`);
    }

    const root = parseDustNode(parsed);
    const entries = flattenDustTree(root);
    if (entries.length === 0) {
      throw new Error('Dust no devolvió ninguna entrada utilizable para el scan.');
    }

    const scan: ScanDocument = {
      schema: SCAN_SCHEMA,
      id: createScanId(),
      createdAt: new Date().toISOString(),
      source: 'dust',
      computer: hostname(),
      entries,
    };

    await this.storage.saveScan(scan);
    return {
      scan,
      filePath: join(this.storage.scansDir, `${scan.id}.json`),
      depth,
      minSize,
    };
  }
}

function parseDustNode(value: unknown): DustJsonNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('La raíz JSON de Dust no tiene el formato esperado.');
  }

  const node = value as Record<string, unknown>;
  if (typeof node.name !== 'string' || node.name.length === 0) {
    throw new Error('Dust devolvió un nodo sin nombre válido.');
  }
  if (!(typeof node.size === 'string' || typeof node.size === 'number')) {
    throw new Error(`Dust devolvió un tamaño inválido para ${node.name}.`);
  }
  if (!Array.isArray(node.children)) {
    throw new Error(`Dust devolvió children inválido para ${node.name}.`);
  }

  return {
    name: node.name,
    size: node.size,
    children: node.children.map(parseDustNode),
  };
}

function flattenDustTree(root: DustJsonNode): ScanEntry[] {
  const entries = new Map<string, ScanEntry>();

  const visit = (node: DustJsonNode): void => {
    if (node.name !== '(total)') {
      entries.set(node.name, {
        path: node.name,
        sizeBytes: parseDustSize(node.size),
      });
      if (entries.size > MAX_ENTRIES) {
        throw new Error(`Dust produjo más de ${MAX_ENTRIES} entradas; reduce --depth o aumenta --min-size.`);
      }
    }

    for (const child of node.children) visit(child);
  };

  visit(root);
  return [...entries.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);
}

export function parseDustSize(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Tamaño Dust inválido: ${value}`);
    return Math.round(value);
  }

  const normalized = value.trim().replace(/,/g, '');
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB|TB|TIB|PB|PIB|K|KI|M|MI|G|GI|T|TI|P|PI)?$/i);
  if (!match) throw new Error(`No se puede convertir el tamaño de Dust: ${value}`);

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
  if (!factor) throw new Error(`Unidad de tamaño Dust no soportada: ${unit}`);
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
        fail(new Error(`La salida JSON de Dust supera el máximo permitido de ${maxOutputBytes} bytes.`));
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 1024 * 1024) stderr.push(chunk);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        fail(new Error(`No se encuentra '${bin}'. Instala Dust o define ANSYSWARDEN_DUST_BIN.`));
        return;
      }
      fail(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      const errText = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        fail(new Error(`Dust terminó con código ${String(code)}${errText ? `: ${errText}` : ''}`));
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
