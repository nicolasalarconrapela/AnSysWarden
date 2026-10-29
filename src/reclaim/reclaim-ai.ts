import { OllamaClient } from '../ai/ollama-client';
import type { AiEvidencePayload } from '../core/classification/types';
import type { ScanDocument } from '../backend/types';
import type { ReclaimCandidate, ReclaimReport } from './reclaim-engine';

const RECLAIM_AI_MODEL = process.env.ANSYSWARDEN_RECLAIM_MODEL ?? 'gemma2:2b';
const RECLAIM_AI_TIMEOUT_MS = readPositiveInt(process.env.ANSYSWARDEN_RECLAIM_AI_TIMEOUT_MS, 45_000);
const RECLAIM_AI_WARMUP_TIMEOUT_MS = readPositiveInt(
  process.env.ANSYSWARDEN_RECLAIM_AI_WARMUP_TIMEOUT_MS,
  120_000,
);

export interface ReclaimAiFinding {
  path: string;
  sizeBytes: number;
  evidence: AiEvidencePayload;
  model: string;
}

export interface ReclaimAiResult {
  model: string;
  warmupMs?: number;
  analyzed: ReclaimAiFinding[];
  failures: Array<{ path: string; error: string }>;
}

export async function analyzeAmbiguousCandidates(
  scan: ScanDocument,
  report: ReclaimReport,
  limit = 3,
): Promise<ReclaimAiResult> {
  const client = new OllamaClient(
    process.env.OLLAMA_HOST_URL ?? 'http://127.0.0.1:11434',
    RECLAIM_AI_MODEL,
  );
  const selected = selectTopLevelAmbiguous(report.reviewCandidates, limit);
  const analyzed: ReclaimAiFinding[] = [];
  const failures: Array<{ path: string; error: string }> = [];

  if (selected.length === 0) {
    return { model: client.getModel(), analyzed, failures };
  }

  let warmupMs: number | undefined;
  try {
    const warmup = await client.warmup(RECLAIM_AI_WARMUP_TIMEOUT_MS);
    warmupMs = warmup.durationMs;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const candidate of selected) {
      failures.push({
        path: candidate.path,
        error: `No se pudo preparar ${client.getModel()}: ${message}`,
      });
    }
    return { model: client.getModel(), analyzed, failures };
  }

  for (const candidate of selected) {
    try {
      const context = buildContext(scan, candidate);
      const evidence = await client.analyzePath(context, RECLAIM_AI_TIMEOUT_MS);
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

  return { model: client.getModel(), warmupMs, analyzed, failures };
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
    .slice(0, 5)
    .map((entry) => `${relativeTo(candidate.path, entry.path)}:${entry.sizeBytes}`);

  return [
    `role=${scan.origin?.deviceRole ?? 'unknown'} platform=${scan.origin?.platform ?? 'unknown'}`,
    `root=${basename(scan.origin?.rootPath ?? '')}`,
    `candidate=${basename(candidate.path)} size=${candidate.sizeBytes}`,
    ...(descendants.length > 0 ? [`children=${descendants.join(',')}`] : []),
    'Infer artifact type, regenerability and unique-data risk. Do not authorize deletion.',
  ].join('\n');
}

function relativeTo(parent: string, child: string): string {
  const normalizedParent = normalizePath(parent).replace(/\/$/, '');
  const normalizedChild = normalizePath(child);
  if (!normalizedChild.startsWith(`${normalizedParent}/`)) return basename(child);
  return normalizedChild.slice(normalizedParent.length + 1);
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function isSameOrDescendant(path: string, parent: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedParent = normalizePath(parent).replace(/\/$/, '');
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase();
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
