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

export type ReclaimAiProgressEvent =
  | { type: 'selection'; requested: number; selected: number; model: string }
  | { type: 'warmup-start'; model: string }
  | { type: 'warmup-done'; model: string; durationMs: number }
  | { type: 'warmup-failed'; model: string; durationMs: number; error: string }
  | { type: 'candidate-start'; index: number; total: number; path: string }
  | { type: 'candidate-done'; index: number; total: number; path: string; durationMs: number }
  | { type: 'candidate-failed'; index: number; total: number; path: string; durationMs: number; error: string };

export type ReclaimAiProgressHandler = (event: ReclaimAiProgressEvent) => void;

export async function analyzeAmbiguousCandidates(
  scan: ScanDocument,
  report: ReclaimReport,
  limit = 3,
  onProgress?: ReclaimAiProgressHandler,
): Promise<ReclaimAiResult> {
  const client = new OllamaClient(
    process.env.OLLAMA_HOST_URL ?? 'http://127.0.0.1:11434',
    RECLAIM_AI_MODEL,
  );
  const selected = selectTopLevelAmbiguous(report.reviewCandidates, limit);
  const analyzed: ReclaimAiFinding[] = [];
  const failures: Array<{ path: string; error: string }> = [];

  onProgress?.({
    type: 'selection',
    requested: limit,
    selected: selected.length,
    model: client.getModel(),
  });

  if (selected.length === 0) {
    return { model: client.getModel(), analyzed, failures };
  }

  let warmupMs: number | undefined;
  const warmupStartedAt = Date.now();
  onProgress?.({ type: 'warmup-start', model: client.getModel() });
  try {
    const warmup = await client.warmup(RECLAIM_AI_WARMUP_TIMEOUT_MS);
    warmupMs = warmup.durationMs;
    onProgress?.({
      type: 'warmup-done',
      model: client.getModel(),
      durationMs: warmup.durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - warmupStartedAt;
    onProgress?.({
      type: 'warmup-failed',
      model: client.getModel(),
      durationMs,
      error: message,
    });
    for (const candidate of selected) {
      failures.push({
        path: candidate.path,
        error: `No se pudo preparar ${client.getModel()}: ${message}`,
      });
    }
    return { model: client.getModel(), analyzed, failures };
  }

  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    const position = index + 1;
    const startedAt = Date.now();
    onProgress?.({
      type: 'candidate-start',
      index: position,
      total: selected.length,
      path: candidate.path,
    });

    try {
      const context = buildContext(scan, candidate);
      const evidence = await client.analyzePath(context, RECLAIM_AI_TIMEOUT_MS);
      const durationMs = Date.now() - startedAt;
      analyzed.push({
        path: candidate.path,
        sizeBytes: candidate.sizeBytes,
        evidence,
        model: client.getModel(),
      });
      onProgress?.({
        type: 'candidate-done',
        index: position,
        total: selected.length,
        path: candidate.path,
        durationMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startedAt;
      failures.push({
        path: candidate.path,
        error: message,
      });
      onProgress?.({
        type: 'candidate-failed',
        index: position,
        total: selected.length,
        path: candidate.path,
        durationMs,
        error: message,
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
    .filter((entry) => entry.path !== candidate.path && isSameOrDescendant(entry.path, candidate.path));

  const largest = [...descendants]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 6)
    .map((entry) => `${relativeTo(candidate.path, entry.path)}:${entry.sizeBytes}`);

  const signals = detectStructuralSignals(candidate.path, descendants.map((entry) => entry.path));

  return [
    `role=${scan.origin?.deviceRole ?? 'unknown'} platform=${scan.origin?.platform ?? 'unknown'}`,
    `root=${basename(scan.origin?.rootPath ?? '')}`,
    `candidate=${basename(candidate.path)} size=${candidate.sizeBytes}`,
    ...(signals.length > 0 ? [`machine_signals=${signals.join(';')}`] : []),
    ...(largest.length > 0 ? [`largest_descendants=${largest.join(',')}`] : []),
    'Machine signals are advisory structural observations, not proof and not deletion authorization.',
    'Directory size is only a prioritization signal. Never infer persistence, uniqueness, or user-data risk from size alone.',
    'Infer artifact type, regenerability and unique-data risk from the structure. Preserve uncertainty when evidence is insufficient.',
    'Do not authorize deletion.',
  ].join('\n');
}

function detectStructuralSignals(candidatePath: string, descendantPaths: string[]): string[] {
  const signals: string[] = [];
  const relatives = descendantPaths.map((path) => relativeTo(candidatePath, path));
  const candidateName = basename(candidatePath).toLowerCase();

  const hasDepsDirectory = relatives.some((path) => /(^|\/)deps$/i.test(path));
  const hasBuildDirectory = relatives.some((path) => /(^|\/)build$/i.test(path));
  const hasDebugProfile = relatives.some((path) => /^debug(\/|$)/i.test(path));
  const hasReleaseProfile = relatives.some((path) => /^release(\/|$)/i.test(path));
  const hashedGenerationCount = relatives.filter((path) => /(^|\/)[^/]+-[0-9a-f]{12,}$/i.test(path)).length;

  const profileNames = new Set<string>();
  for (const path of relatives) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length >= 2 && ['deps', 'build'].includes(parts[1].toLowerCase())) {
      profileNames.add(parts[0]);
    }
  }

  if (candidateName === 'target' && hasDepsDirectory && hasBuildDirectory) {
    signals.push('target-with-deps-and-build');
  }
  if (candidateName === 'target' && (hasDebugProfile || hasReleaseProfile || profileNames.size >= 2)) {
    signals.push(`multiple-build-profiles:${[...profileNames].slice(0, 4).join(',') || 'detected'}`);
  }
  if (hashedGenerationCount > 0) {
    signals.push(`hashed-build-like-generations:${hashedGenerationCount}`);
  }
  if (candidateName === 'target' && hasDepsDirectory && hasBuildDirectory && hashedGenerationCount > 0) {
    signals.push('cargo-like-build-tree-unconfirmed');
  }

  return signals;
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
