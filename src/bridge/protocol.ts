import type { ClassificationResult } from '../ai/types';
import type { ArtifactProfile } from '../profiler/artifact-profiler';

export const BRIDGE_PROTOCOL = 'ansyswarden.bridge.v1' as const;
export const DEFAULT_BRIDGE_PORT = 8787;
export const DEFAULT_BRIDGE_HOST = '0.0.0.0';
export const MAX_BRIDGE_BODY_BYTES = 1024 * 1024;

export interface BridgeHealthResponse {
  protocol: typeof BRIDGE_PROTOCOL;
  ok: true;
  role: 'mobile-ai';
  model: string;
  timestamp: string;
}

export interface BridgeClassifyRequest {
  protocol: typeof BRIDGE_PROTOCOL;
  requestId: string;
  path: string;
  profile?: ArtifactProfile;
}

export interface BridgeClassifyResponse {
  protocol: typeof BRIDGE_PROTOCOL;
  requestId: string;
  result: ClassificationResult;
  processedBy: 'rule' | 'mobile-ai' | 'fallback';
  durationMs: number;
}

export interface BridgeErrorResponse {
  protocol: typeof BRIDGE_PROTOCOL;
  requestId?: string;
  error: string;
}

export function isBridgeClassifyRequest(value: unknown): value is BridgeClassifyRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;

  if (candidate.protocol !== BRIDGE_PROTOCOL) return false;
  if (typeof candidate.requestId !== 'string' || candidate.requestId.length < 8 || candidate.requestId.length > 128) return false;
  if (typeof candidate.path !== 'string' || candidate.path.length === 0 || candidate.path.length > 16_384) return false;

  if (candidate.profile === undefined) return true;
  return isArtifactProfile(candidate.profile);
}

function isArtifactProfile(value: unknown): value is ArtifactProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Record<string, unknown>;

  return (
    typeof profile.path === 'string'
    && isNonNegativeNumber(profile.sizeBytes)
    && isNonNegativeNumber(profile.fileCount)
    && isNonNegativeNumber(profile.directoryCount)
    && isNonNegativeNumber(profile.skippedEntries)
    && isNullableFiniteNumber(profile.newestMtimeMs)
    && isNullableFiniteNumber(profile.oldestMtimeMs)
    && Array.isArray(profile.extensions)
    && profile.extensions.length <= 32
    && profile.extensions.every((item) => {
      if (!item || typeof item !== 'object') return false;
      const extension = item as Record<string, unknown>;
      return typeof extension.extension === 'string'
        && extension.extension.length <= 64
        && isNonNegativeNumber(extension.files)
        && isNonNegativeNumber(extension.bytes);
    })
  );
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}
