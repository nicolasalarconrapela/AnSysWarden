import { platform } from 'node:os';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CreateTreeInventory } from '../application/tree/create-tree-inventory';
import { NativeTreeScannerAdapter } from '../infrastructure/filesystem/native-tree-scanner-adapter';
import type { TreeScanMetadata, TreeScanOptions } from '../core/inventory/tree-types';
import { analyzeTreeActivity, type ActivityReport } from './analysis/activity';
import { analyzeTreeAge, type AgeReport } from './analysis/age';
import { measureAllocatedSpace, type AllocationSummary } from './analysis/allocation';
import { buildInventoryManifest, saveInventoryManifest, type InventoryManifest } from './inventory-manifest';

/**
 * Inventario del PC bajo el subsistema Dust/Inventory.
 *
 * Importante: el ejecutable Dust actual limita profundidad y entradas,
 * por lo que NO es la fuente de verdad para enumerar todos los ficheros.
 * Este caso de uso usa el scanner nativo completo como adaptador de
 * inventario y aprovecha los análisis existentes sobre el mismo JSONL.
 * Tree solo necesita consumir el snapshot resultante.
 */
export interface InventorySnapshotOptions extends TreeScanOptions {
  /** Desactivar una segunda pasada de medición física en Windows. */
  allocated?: boolean;
  ageDays?: number;
  activityDays?: number;
}

export interface InventorySnapshot {
  metadata: TreeScanMetadata;
  age: { report: AgeReport; outputPath: string };
  activity: { report: ActivityReport; outputPath: string };
  allocation: { summary: AllocationSummary; outputPath: string } | null;
  warnings: string[];
  manifest: InventoryManifest;
  manifestPath: string;
}

export class CreateInventorySnapshot {
  constructor(
    private readonly scanner = new CreateTreeInventory(new NativeTreeScannerAdapter()),
  ) {}

  async execute(rootPath: string, options: InventorySnapshotOptions = {}): Promise<InventorySnapshot> {
    // Un índice seleccionado mediante --out nunca debe sobrescribir una captura previa.
    if (options.outputPath) {
      const destination = resolve(options.outputPath);
      try {
        await access(destination);
        throw new Error('El índice ya existe; no se sobrescribe: ' + destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const metadata = await this.scanner.execute(rootPath, {
      ...(options.outputPath === undefined ? {} : { outputPath: options.outputPath }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.progressEvery === undefined ? {} : { progressEvery: options.progressEvery }),
    });
    const age = await analyzeTreeAge(metadata, { days: options.ageDays ?? 180 });
    const activity = await analyzeTreeActivity(metadata, { days: options.activityDays ?? 180 });
    let allocation: InventorySnapshot['allocation'] = null;
    const warnings: string[] = [];

    if (options.allocated !== false) {
      if (platform() !== 'win32') {
        warnings.push('Espacio asignado no medido: el adaptador disponible requiere Windows.');
      } else if (metadata.files === 0) {
        warnings.push('Espacio asignado no medido: no hay archivos normales.');
      } else {
        try {
          allocation = await measureAllocatedSpace(metadata);
          if (!allocation.summary.complete) {
            warnings.push('Espacio asignado parcialmente medido: revisar los errores por archivo.');
          }
        } catch (error) {
          warnings.push('No se pudo medir el espacio asignado: ' +
            (error instanceof Error ? error.message : String(error)));
        }
      }
    } else {
      warnings.push('Espacio asignado omitido expresamente; no equivale a 0 bytes.');
    }
    if (metadata.errors > 0) {
      warnings.push('Inventario incompleto: ' + metadata.errors + ' errores de lectura.');
    }

    const manifest = buildInventoryManifest({
      metadata,
      agePath: age.outputPath,
      activityPath: activity.outputPath,
      allocation,
      allocatedRequested: options.allocated !== false,
      warnings,
    });
    const manifestPath = await saveInventoryManifest(manifest);
    return { metadata, age, activity, allocation, warnings, manifest, manifestPath };
  }
}
