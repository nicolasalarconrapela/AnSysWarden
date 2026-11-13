import type { TreeScanMetadata, TreeScanOptions } from '../../../core/inventory/tree-types';

/**
 * Puerto de salida del PC: el caso de uso no conoce Node.js, NTFS,
 * JSONL ni la implementación concreta que enumera carpetas.
 */
export interface TreeInventoryScannerPort {
  scan(rootPath: string, options?: TreeScanOptions): Promise<TreeScanMetadata>;
}
