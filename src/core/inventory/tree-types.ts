/**
 * Contrato interno del inventario del PC.
 *
 * Este modelo describe una captura; no autoriza borrados ni contiene
 * decisiones de la IA. Mantener su semántica y el schema v1 estables.
 */
export const TREE_INDEX_SCHEMA = 'ansyswarden.tree-index.v1' as const;

export type TreeEntryType = 'directory' | 'file' | 'symlink' | 'other';

export interface TreeEntryRecord {
  record: 'entry';
  path: string;
  parentPath?: string;
  name: string;
  type: TreeEntryType;
  depth: number;
  sizeBytes: number;
  mtimeMs: number;
  atimeMs: number;
  birthtimeMs?: number;
}

export interface TreeDirectorySummaryRecord {
  record: 'directory-summary';
  path: string;
  sizeBytes: number;
  files: number;
  directories: number;
  errors: number;
}

export interface TreeErrorRecord {
  record: 'error';
  path: string;
  parentPath?: string;
  name: string;
  depth: number;
  code?: string;
  message: string;
}

export type TreeIndexRecord = TreeEntryRecord | TreeDirectorySummaryRecord | TreeErrorRecord;

export interface TreeScanMetadata {
  schema: typeof TREE_INDEX_SCHEMA;
  id: string;
  createdAt: string;
  rootPath: string;
  computer: string;
  platform: string;
  indexPath: string;
  entries: number;
  files: number;
  directories: number;
  symlinks: number;
  others: number;
  errors: number;
  sizeBytes: number;
}

export interface TreeScanProgress {
  entries: number;
  files: number;
  directories: number;
  errors: number;
  currentPath: string;
}

export interface TreeScanOptions {
  outputPath?: string;
  onProgress?: (progress: TreeScanProgress) => void;
  progressEvery?: number;
}
