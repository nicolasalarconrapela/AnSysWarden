export type ProfileLimitReason = 'MAX_FILES' | 'MAX_DIRECTORIES' | 'MAX_DURATION';

export interface ArtifactProfile {
  path: string;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  skippedEntries: number;
  newestMtimeMs: number | null;
  oldestMtimeMs: number | null;
  extensions: Array<{ extension: string; files: number; bytes: number }>;
  profileComplete?: boolean;
  limitReason?: ProfileLimitReason | null;
}
