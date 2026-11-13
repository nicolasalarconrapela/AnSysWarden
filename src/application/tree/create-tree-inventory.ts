import type { TreeScanMetadata, TreeScanOptions } from '../../core/inventory/tree-types';
import type { TreeInventoryScannerPort } from './ports/tree-inventory-scanner.port';

/**
 * Caso de uso de entrada. Coordina el escaneo mediante un puerto.
 * La validación de rutas y la persistencia siguen en el adaptador nativo
 * durante la migración incremental, para preservar el comportamiento.
 */
export class CreateTreeInventory {
  constructor(private readonly scanner: TreeInventoryScannerPort) {}

  execute(rootPath: string, options: TreeScanOptions = {}): Promise<TreeScanMetadata> {
    return this.scanner.scan(rootPath, options);
  }
}
