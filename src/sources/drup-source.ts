import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { BackendStorage } from '../backend/storage';
import {
  SOURCE_CAPTURE_SCHEMA,
  type SourceCaptureDocument,
  type SourceCaptureFormat,
  type SourceInspection,
} from './types';

const DEFAULT_MAX_SOURCE_BYTES = 100 * 1024 * 1024;

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class DrupSource {
  readonly sourceName = 'drup';
  readonly root: string;

  private readonly maxBytes = readPositiveInt(
    process.env.ANSYSWARDEN_SOURCE_MAX_BYTES,
    DEFAULT_MAX_SOURCE_BYTES,
  );

  constructor(storage = new BackendStorage()) {
    this.root = join(storage.root, 'sources', this.sourceName);
  }

  async inspect(inputFile: string): Promise<SourceInspection> {
    const { text, byteLength } = await this.readInput(inputFile);
    const decoded = decodePayload(text);

    return {
      source: this.sourceName,
      inputFile: basename(inputFile),
      format: decoded.format,
      byteLength,
      topLevel: decoded.topLevel,
      keys: decoded.keys,
      ...(decoded.itemCount === undefined ? {} : { itemCount: decoded.itemCount }),
    };
  }

  async stage(inputFile: string): Promise<{ path: string; capture: SourceCaptureDocument }> {
    const { text, byteLength } = await this.readInput(inputFile);
    const decoded = decodePayload(text);
    const capture: SourceCaptureDocument = {
      schema: SOURCE_CAPTURE_SCHEMA,
      id: createCaptureId(),
      source: this.sourceName,
      capturedAt: new Date().toISOString(),
      computer: hostname(),
      inputFile: basename(inputFile),
      format: decoded.format,
      byteLength,
      payload: decoded.payload,
    };

    await mkdir(this.root, { recursive: true });
    const destination = join(this.root, `${capture.id}.json`);
    await atomicWriteJson(destination, capture);
    await atomicWriteJson(join(this.root, 'latest.json'), capture);
    return { path: destination, capture };
  }

  private async readInput(inputFile: string): Promise<{ text: string; byteLength: number }> {
    const absolute = resolve(inputFile);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`La entrada de drup no es un archivo regular: ${absolute}`);
    if (info.size <= 0) throw new Error(`La salida de drup está vacía: ${absolute}`);
    if (info.size > this.maxBytes) {
      throw new Error(`La salida de drup supera el máximo permitido (${info.size} > ${this.maxBytes} bytes).`);
    }

    return {
      text: await readFile(absolute, 'utf8'),
      byteLength: info.size,
    };
  }
}

interface DecodedPayload {
  format: SourceCaptureFormat;
  payload: unknown;
  topLevel: SourceInspection['topLevel'];
  keys: string[];
  itemCount?: number;
}

function decodePayload(text: string): DecodedPayload {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return {
        format: 'json',
        payload: parsed,
        topLevel: 'array',
        keys: keysFromArray(parsed),
        itemCount: parsed.length,
      };
    }

    if (parsed && typeof parsed === 'object') {
      return {
        format: 'json',
        payload: parsed,
        topLevel: 'object',
        keys: Object.keys(parsed as Record<string, unknown>).slice(0, 32),
      };
    }

    return {
      format: 'json',
      payload: parsed,
      topLevel: 'scalar',
      keys: [],
    };
  } catch {
    return {
      format: 'text',
      payload: text,
      topLevel: 'text',
      keys: [],
    };
  }
}

function keysFromArray(items: unknown[]): string[] {
  for (const item of items.slice(0, 20)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.keys(item as Record<string, unknown>).slice(0, 32);
    }
  }
  return [];
}

function createCaptureId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `drup-${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temp, path);
}
