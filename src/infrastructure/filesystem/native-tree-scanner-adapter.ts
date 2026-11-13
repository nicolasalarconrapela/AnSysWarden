import type { TreeInventoryScannerPort } from '../../application/tree/ports/tree-inventory-scanner.port';
import type { TreeScanMetadata, TreeScanOptions } from '../../core/inventory/tree-types';
import { NativeTreeScanner } from '../../tree/native-tree-scanner';

/**
 * Adaptador de infraestructura: encapsula el motor nativo existente.
 * No crea otro recorrido ni modifica la salida JSONL.
 */
export class NativeTreeScannerAdapter implements TreeInventoryScannerPort {
  constructor(private readonly nativeScanner = new NativeTreeScanner()) {}

  scan(rootPath: string, options?: TreeScanOptions): Promise<TreeScanMetadata> {
    return this.nativeScanner.scan(rootPath, options);
  }
}
