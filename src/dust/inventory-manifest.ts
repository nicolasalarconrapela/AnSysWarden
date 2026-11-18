import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TreeScanMetadata } from '../core/inventory/tree-types';
import type { AllocationSummary } from '../tree/tree-allocation';

export const INVENTORY_MANIFEST_SCHEMA = 'ansyswarden.inventory-manifest.v1' as const;
export type InventoryCaptureStatus = 'COMPLETE' | 'PARTIAL';
export type AllocationCaptureStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE' | 'SKIPPED';

export interface InventoryManifest {
  schema: typeof INVENTORY_MANIFEST_SCHEMA;
  scanId: string;
  rootPath: string;
  indexPath: string;
  capturedAt: string;
  generatedAt: string;
  status: InventoryCaptureStatus;
  source: 'native-filesystem';
  coverage: {
    entries: number;
    files: number;
    directories: number;
    symlinks: number;
    others: number;
    errors: number;
  };
  space: {
    logicalBytes: number;
    allocatedBytesMeasured: number | null;
    allocated: AllocationCaptureStatus;
    method: string | null;
  };
  timestamps: {
    mtime: 'RECORDED';
    atime: 'RECORDED_BUT_NOT_RELIABLE_AS_USAGE';
    birthtime: 'RECORDED_WHEN_AVAILABLE';
  };
  reports: {
    age: string;
    activity: string;
    allocation: string | null;
  };
  warnings: string[];
}

/** Captura completa significa cobertura del recorrido, no espacio físico medido al 100 %. */
export function buildInventoryManifest(input: {
  metadata: TreeScanMetadata;
  agePath: string;
  activityPath: string;
  allocation: { outputPath: string; summary: AllocationSummary } | null;
  allocatedRequested: boolean;
  warnings: string[];
}): InventoryManifest {
  const { metadata, allocation, allocatedRequested } = input;
  const allocated: AllocationCaptureStatus = !allocatedRequested ? 'SKIPPED'
    : !allocation ? 'UNAVAILABLE'
    : allocation.summary.complete ? 'COMPLETE' : 'PARTIAL';

  return {
    schema: INVENTORY_MANIFEST_SCHEMA,
    scanId: metadata.id,
    rootPath: metadata.rootPath,
    indexPath: metadata.indexPath,
    capturedAt: metadata.createdAt,
    generatedAt: new Date().toISOString(),
    status: metadata.errors > 0 ? 'PARTIAL' : 'COMPLETE',
    source: 'native-filesystem',
    coverage: {
      entries: metadata.entries,
      files: metadata.files,
      directories: metadata.directories,
      symlinks: metadata.symlinks,
      others: metadata.others,
      errors: metadata.errors,
    },
    space: {
      logicalBytes: metadata.sizeBytes,
      allocatedBytesMeasured: allocation ? allocation.summary.allocatedBytesMeasured : null,
      allocated,
      method: allocation ? allocation.summary.method : null,
    },
    timestamps: {
      mtime: 'RECORDED',
      atime: 'RECORDED_BUT_NOT_RELIABLE_AS_USAGE',
      birthtime: 'RECORDED_WHEN_AVAILABLE',
    },
    reports: {
      age: input.agePath,
      activity: input.activityPath,
      allocation: allocation?.outputPath ?? null,
    },
    warnings: input.warnings.slice(),
  };
}

/**
 * Manifiesto derivado, separado del índice JSONL v1 original.
 * Primero escribe un temporal y después publica el fichero terminado.
 */
export async function saveInventoryManifest(manifest: InventoryManifest): Promise<string> {
  const directory = resolve('.ansyswarden', 'tree', 'manifests');
  await mkdir(directory, { recursive: true });
  const outputPath = join(directory, manifest.scanId + '.json');
  try {
    await access(outputPath);
    throw new Error('Ya existe el manifiesto para ' + manifest.scanId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporaryPath = outputPath + '.tmp-' + randomUUID();
  try {
    await writeFile(temporaryPath, JSON.stringify(manifest, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return outputPath;
}
