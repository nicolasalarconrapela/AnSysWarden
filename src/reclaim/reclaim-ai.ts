import { OllamaClient } from '../ai/ollama-client';
import type { AiEvidencePayload } from '../core/classification/types';
import type { ScanDocument } from '../backend/types';
import type { ReclaimCandidate, ReclaimReport } from './reclaim-engine';

export interface ReclaimAiFinding {
  path: string;
  sizeBytes: number;
  evidence: AiEvidencePayload;
  model: string;
}

export interface ReclaimAiResult {
  model: string;
  analyzed: ReclaimAiFinding[];
  failures: Array<{ path: string; error: string }>;
}

export async function analyzeAmbiguousCandidates(
  scan: ScanDocument,
  report: ReclaimReport,
  limit = 3,
): Promise<ReclaimAiResult> {
  const client = new OllamaClient();
  const selected = selectTopLevelAmbiguous(report.reviewCandidates, limit);
  const analyzed: ReclaimAiFinding[] = [];
  const failures: Array<{ path: string; error: string }> = [];

  for (const candidate of selected) {
    try {
      const context = buildContext(scan, candidate);
      const evidence = await client.analyzePath(context);
      analyzed.push({
        path: candidate.path,
        sizeBytes: candidate.sizeBytes,
        evidence,
        model: client.getModel(),
      });
    } catch (error) {
      failures.push({
        path: candidate.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { model: client.getModel(), analyzed, failures };
}

function selectTopLevelAmbiguous(candidates: ReclaimCandidate[], limit: number): ReclaimCandidate[] {
  const selected: ReclaimCandidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.sizeBytes - a.sizeBytes)) {
    if (selected.some((parent) => isSameOrDescendant(candidate.path, parent.path))) continue;
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
}

function buildContext(scan: ScanDocument, candidate: ReclaimCandidate): string {
  const descendants = scan.entries
    .filter((entry) => entry.path !== candidate.path && isSameOrDescendant(entry.path, candidate.path))
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 8)
    .map((entry) => `${entry.path} (${entry.sizeBytes} bytes)`);

  return [
    `SCAN ORIGIN role=${scan.origin?.deviceRole ?? 'unknown'} platform=${scan.origin?.platform ?? 'unknown'} root=${scan.origin?.rootPath ?? 'unknown'}`,
    `CANDIDATE sizeBytes=${candidate.sizeBytes}`,
    `CANDIDATE PATH=${candidate.path}`,
    ...(descendants.length > 0 ? ['LARGEST DESCENDANTS:', ...descendants] : []),
    'Assess what this artifact likely is, whether it is regenerable, and the risk of unique user data.',
    'Do not authorize deletion. Preserve uncertainty when the path alone is insufficient.',
  ].join('\n');
}

function isSameOrDescendant(path: string, parent: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedParent = normalizePath(parent).replace(/\/$/, '');
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase();
}
