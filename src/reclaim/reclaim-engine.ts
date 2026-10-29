import type { ScanDocument, ScanEntry } from '../backend/types';
import { classifyByRules } from '../core/classification/rules';
import {
  buildReclaimPolicyState,
  type ReclaimContext,
  type ReclaimDecision,
  type ReclaimPolicyInput,
  type ReclaimQuestion,
  type ReclaimScopeContext,
} from './reclaim-policy';

export type ReclaimAction = 'DELETE' | 'REVIEW' | 'PROTECT' | 'KEEP' | 'OPTIMIZE';
export type ReclaimTreeDecision = ReclaimDecision | 'ROOT';

export interface ReclaimCandidate {
  action: ReclaimAction;
  path: string;
  sizeBytes: number;
  reason: string;
  confidence: number;
  source: 'rule' | 'fallback' | 'policy';
}

export interface ReclaimTreeNode {
  entryId?: string;
  path: string;
  name: string;
  sizeBytes: number;
  decision: ReclaimTreeDecision;
  reason?: string;
  children: ReclaimTreeNode[];
}

export interface ReclaimReport {
  scanId: string;
  totalEntries: number;
  analyzedEntries: number;
  rootFallbackUsed: boolean;
  confirmedRecoverableBytes: number;
  context: ReclaimContext;
  questions: ReclaimQuestion[];
  needsUserInput: boolean;
  tree: ReclaimTreeNode[];
  deleteCandidates: ReclaimCandidate[];
  reviewCandidates: ReclaimCandidate[];
  protectCandidates: ReclaimCandidate[];
  keepCandidates: ReclaimCandidate[];
  optimizeCandidates: ReclaimCandidate[];
}

export function buildReclaimReport(
  scan: ScanDocument,
  policyInput: ReclaimPolicyInput = {},
): ReclaimReport {
  const nonRootEntries = scan.entries.filter((entry) => !isScanRoot(entry, scan));
  const rootFallbackUsed = nonRootEntries.length === 0;
  const entriesToAnalyze = rootFallbackUsed ? scan.entries : nonRootEntries;
  const policy = buildReclaimPolicyState(scan, policyInput);

  const candidates = entriesToAnalyze
    .map((entry) => toCandidate(entry, policy.context))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);

  const deleteCandidates = candidates.filter((candidate) => candidate.action === 'DELETE');
  const reviewCandidates = candidates.filter((candidate) => candidate.action === 'REVIEW');
  const protectCandidates = candidates.filter((candidate) => candidate.action === 'PROTECT');
  const keepCandidates = candidates.filter((candidate) => candidate.action === 'KEEP');
  const optimizeCandidates = candidates.filter((candidate) => candidate.action === 'OPTIMIZE');

  return {
    scanId: scan.id,
    totalEntries: scan.entries.length,
    analyzedEntries: entriesToAnalyze.length,
    rootFallbackUsed,
    confirmedRecoverableBytes: sumNonOverlapping(deleteCandidates),
    context: policy.context,
    questions: policy.questions,
    needsUserInput: policy.questions.length > 0,
    tree: buildReclaimTree(scan, candidates, policy.questions),
    deleteCandidates,
    reviewCandidates,
    protectCandidates,
    keepCandidates,
    optimizeCandidates,
  };
}

function toCandidate(entry: ScanEntry, context: ReclaimContext): ReclaimCandidate {
  return applyContextPolicy(entry, classifyEntry(entry), context);
}

function classifyEntry(entry: ScanEntry): ReclaimCandidate {
  const classification = classifyByRules(entry.path);

  if (!classification) {
    return {
      action: 'REVIEW',
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      reason: 'No deterministic rule can prove that this content is safely regenerable.',
      confidence: 0,
      source: 'fallback',
    };
  }

  if (classification.classification === 'SAFE_CACHE') {
    return {
      action: 'DELETE',
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      reason: classification.reason,
      confidence: classification.confidence,
      source: 'rule',
    };
  }

  if (classification.classification === 'USER_DATA') {
    return {
      action: 'PROTECT',
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      reason: classification.reason,
      confidence: classification.confidence,
      source: 'rule',
    };
  }

  return {
    action: 'REVIEW',
    path: entry.path,
    sizeBytes: entry.sizeBytes,
    reason: classification.reason,
    confidence: classification.confidence,
    source: classification.source === 'rule' ? 'rule' : 'fallback',
  };
}

function applyContextPolicy(
  entry: ScanEntry,
  base: ReclaimCandidate,
  context: ReclaimContext,
): ReclaimCandidate {
  // A contextual policy may make a deletion recommendation more conservative,
  // but it must never weaken deterministic protection of user data.
  if (base.action === 'PROTECT') return base;

  const scope = findScope(context, entry.path);
  if (!scope || scope.domain !== 'development') return base;

  if (scope.projectLifecycle === 'active') {
    const relative = relativeTo(scope.path, entry.path);

    if (isActiveDevelopmentDependency(relative)) {
      return {
        action: 'KEEP',
        path: entry.path,
        sizeBytes: entry.sizeBytes,
        reason: 'Proyecto activo: dependencia o estado de compilación regenerable pero útil para continuar trabajando sin recompilar innecesariamente.',
        confidence: 0.95,
        source: 'policy',
      };
    }

    if (isBuildGenerationArea(relative)) {
      return {
        action: 'REVIEW',
        path: entry.path,
        sizeBytes: entry.sizeBytes,
        reason: 'Proyecto activo: es un artefacto de build regenerable, pero faltan antigüedad/uso para demostrar que esta generación ya es obsoleta.',
        confidence: Math.max(base.confidence, 0.7),
        source: 'policy',
      };
    }
  }

  return base;
}

function findScope(context: ReclaimContext, path: string): ReclaimScopeContext | undefined {
  const matches = context.scopes.filter((scope) => isSameOrDescendant(path, scope.path));
  return matches.sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length)[0];
}

function isActiveDevelopmentDependency(relativePath: string): boolean {
  const relative = normalizeRelative(relativePath);
  return /(^|\/)target\/[^/]+\/deps(\/|$)/i.test(relative)
    || /(^|\/)target\/[^/]+\/incremental(\/|$)/i.test(relative)
    || /(^|\/)node_modules(\/|$)/i.test(relative)
    || /(^|\/)(\.venv|venv)(\/|$)/i.test(relative)
    || /(^|\/)\.gradle\/caches(\/|$)/i.test(relative);
}

function isBuildGenerationArea(relativePath: string): boolean {
  const relative = normalizeRelative(relativePath);
  return /(^|\/)target\/[^/]+\/build(\/|$)/i.test(relative);
}

function buildReclaimTree(
  scan: ScanDocument,
  candidates: ReclaimCandidate[],
  questions: ReclaimQuestion[],
): ReclaimTreeNode[] {
  const candidateByPath = new Map(
    candidates.map((candidate) => [normalizePath(candidate.path), candidate]),
  );
  const questionByPath = new Map(
    questions.map((question) => [normalizePath(question.path), question]),
  );
  const entryById = new Map<string, ScanEntry>();
  const childrenByParentId = new Map<string, ScanEntry[]>();
  const roots: ScanEntry[] = [];

  for (const entry of scan.entries) {
    if (entry.entryId) entryById.set(entry.entryId, entry);
  }

  for (const entry of scan.entries) {
    if (entry.parentId && entryById.has(entry.parentId)) {
      const children = childrenByParentId.get(entry.parentId) ?? [];
      children.push(entry);
      childrenByParentId.set(entry.parentId, children);
    } else {
      roots.push(entry);
    }
  }

  const sortBySize = (a: ScanEntry, b: ScanEntry): number => b.sizeBytes - a.sizeBytes;
  roots.sort(sortBySize);
  for (const children of childrenByParentId.values()) children.sort(sortBySize);

  const toNode = (entry: ScanEntry): ReclaimTreeNode => {
    const normalized = normalizePath(entry.path);
    const question = questionByPath.get(normalized);
    const candidate = candidateByPath.get(normalized);
    const children = entry.entryId
      ? (childrenByParentId.get(entry.entryId) ?? []).map(toNode)
      : [];

    if (question) {
      return {
        ...(entry.entryId ? { entryId: entry.entryId } : {}),
        path: entry.path,
        name: displayName(entry.path),
        sizeBytes: entry.sizeBytes,
        decision: 'ASK',
        reason: question.reason,
        children,
      };
    }

    if (candidate) {
      return {
        ...(entry.entryId ? { entryId: entry.entryId } : {}),
        path: entry.path,
        name: displayName(entry.path),
        sizeBytes: entry.sizeBytes,
        decision: candidate.action,
        reason: candidate.reason,
        children,
      };
    }

    return {
      ...(entry.entryId ? { entryId: entry.entryId } : {}),
      path: entry.path,
      name: displayName(entry.path),
      sizeBytes: entry.sizeBytes,
      decision: 'ROOT',
      children,
    };
  };

  return roots.map(toNode);
}

function isScanRoot(entry: ScanEntry, scan: ScanDocument): boolean {
  const rootPath = scan.origin?.rootPath;
  if (!rootPath) return entry.depth === 0;
  return normalizePath(entry.path) === normalizePath(rootPath);
}

function sumNonOverlapping(candidates: ReclaimCandidate[]): number {
  const selected: ReclaimCandidate[] = [];
  let total = 0;

  for (const candidate of [...candidates].sort((a, b) => b.sizeBytes - a.sizeBytes)) {
    if (selected.some((parent) => isSameOrDescendant(candidate.path, parent.path))) continue;
    selected.push(candidate);
    total += candidate.sizeBytes;
  }

  return total;
}

function relativeTo(parent: string, child: string): string {
  const normalizedParent = normalizePath(parent).replace(/\/$/, '');
  const normalizedChild = normalizePath(child);
  if (normalizedChild === normalizedParent) return '';
  if (!normalizedChild.startsWith(`${normalizedParent}/`)) return normalizedChild;
  return normalizedChild.slice(normalizedParent.length + 1);
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\//, '').replace(/\/$/, '').toLowerCase();
}

function isSameOrDescendant(path: string, parent: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedParent = normalizePath(parent).replace(/\/$/, '');
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function displayName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit >= 3 ? 2 : unit >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}
