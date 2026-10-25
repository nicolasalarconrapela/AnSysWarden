import type { Classification, ClassificationSource } from './types';

export const AI_INPUT_SCHEMA = 'ansyswarden.ai-input.v1' as const;

export type AiTreePolicy = 'KEEP' | 'DROP';

export type AiTreeKind =
  | 'SOURCE'
  | 'NODE_DEPENDENCIES'
  | 'PYTHON_ENV'
  | 'BUILD_OUTPUT'
  | 'VCS_INTERNAL'
  | 'TOOL_CACHE'
  | 'TOOL_BUNDLE'
  | 'VENDORED'
  | 'GENERATED'
  | 'DOCUMENTATION'
  | 'TEST_OUTPUT'
  | 'IDE_INTERNAL'
  | 'SYSTEM_APP_DATA'
  | 'PROTECTED_USER_DATA'
  | 'SENSITIVE_FILE'
  | 'GIT_IGNORED'
  | 'SYMLINK'
  | 'ACCESS_ERROR'
  | 'DEPTH_LIMIT'
  | 'OTHER';

export interface AiResolvedEntry {
  entryId?: string;
  parentId?: string;
  depth?: number;
  path: string;
  sizeBytes: number;
  classification: Classification;
  confidence: number;
  reason: string;
  source: ClassificationSource;
}

export interface AiCandidateEntry {
  entryId?: string;
  parentId?: string;
  depth?: number;
  path: string;
  sizeBytes: number;
}

export interface AiOmittedEntry {
  path: string;
  name: string;
  kind: AiTreeKind;
  reason: string;
  sizeBytes?: number;
  classification?: Classification;
  classificationSource?: ClassificationSource;
}

export interface AiTreeSummary {
  visibleEntries: number;
  omittedEntries: number;
  skippedEntries: number;
  maxDepth: number;
  maxEntries: number;
  truncated: boolean;
  omittedListTruncated: boolean;
  omittedByKind: Record<string, number>;
  resolvedLocally: number;
  aiCandidates: number;
  ecosystems: string[];
  languages: string[];
  enryAvailable: boolean;
}

export interface AiInputDocument {
  schema: typeof AI_INPUT_SCHEMA;
  scanId: string;
  createdAt: string;
  root: string;
  tree: string;
  summary: AiTreeSummary;
  resolvedLocally: AiResolvedEntry[];
  candidates: AiCandidateEntry[];
  omitted: AiOmittedEntry[];
}
