import type { ScanDocument } from '../backend/types';

export type ReclaimDecision =
  | 'DELETE'
  | 'REVIEW'
  | 'PROTECT'
  | 'KEEP'
  | 'OPTIMIZE'
  | 'ASK';

export type ContentDomain =
  | 'development'
  | 'game'
  | 'images'
  | 'videos'
  | 'documents'
  | 'application'
  | 'system'
  | 'backup'
  | 'downloads'
  | 'unknown';

export type ProjectLifecycle = 'active' | 'paused' | 'finished';

export type ReclaimQuestionKind =
  | 'project_lifecycle'
  | 'usage'
  | 'content_role'
  | 'rebuild_tolerance';

export interface ReclaimQuestionOption {
  value: string;
  label: string;
}

export interface ReclaimQuestion {
  id: string;
  kind: ReclaimQuestionKind;
  path: string;
  prompt: string;
  reason: string;
  options: ReclaimQuestionOption[];
}

export interface ReclaimContext {
  domain: ContentDomain;
  domainConfidence: number;
  domainEvidence: string[];
  projectLifecycle?: ProjectLifecycle;
}

export interface ReclaimPolicyInput {
  projectLifecycle?: ProjectLifecycle;
}

export interface ReclaimPolicyState {
  context: ReclaimContext;
  questions: ReclaimQuestion[];
}

export function buildReclaimPolicyState(
  scan: ScanDocument,
  input: ReclaimPolicyInput = {},
): ReclaimPolicyState {
  const domain = detectDomain(scan);
  const context: ReclaimContext = {
    domain: domain.domain,
    domainConfidence: domain.confidence,
    domainEvidence: domain.evidence,
    ...(input.projectLifecycle ? { projectLifecycle: input.projectLifecycle } : {}),
  };

  const questions: ReclaimQuestion[] = [];
  if (domain.domain === 'development' && !input.projectLifecycle) {
    questions.push({
      id: `project-lifecycle:${scan.id}`,
      kind: 'project_lifecycle',
      path: scan.origin?.rootPath ?? findRootPath(scan),
      prompt: '¿Qué estado tiene este proyecto?',
      reason: 'La limpieza segura depende de si el proyecto sigue activo, está pausado o ya ha finalizado.',
      options: [
        { value: 'active', label: 'Sigo trabajando en él' },
        { value: 'paused', label: 'Está pausado temporalmente' },
        { value: 'finished', label: 'He terminado con el proyecto' },
      ],
    });
  }

  return { context, questions };
}

function detectDomain(scan: ScanDocument): {
  domain: ContentDomain;
  confidence: number;
  evidence: string[];
} {
  const paths = scan.entries.map((entry) => normalizePath(entry.path));
  const hasGit = paths.some((path) => /(^|\/)\.git(\/|$)/i.test(path));
  const buildSignals: string[] = [];

  if (paths.some((path) => /(^|\/)target(\/|$)/i.test(path))) buildSignals.push('cargo-target');
  if (paths.some((path) => /(^|\/)node_modules(\/|$)/i.test(path))) buildSignals.push('node-modules');
  if (paths.some((path) => /(^|\/)\.gradle(\/|$)/i.test(path))) buildSignals.push('gradle');
  if (paths.some((path) => /(^|\/)(\.venv|venv)(\/|$)/i.test(path))) buildSignals.push('python-venv');

  if (hasGit && buildSignals.length > 0) {
    return {
      domain: 'development',
      confidence: 0.95,
      evidence: ['git-repository', ...buildSignals],
    };
  }

  return {
    domain: 'unknown',
    confidence: 0,
    evidence: [],
  };
}

function findRootPath(scan: ScanDocument): string {
  const explicitRoot = scan.entries.find((entry) => entry.depth === 0)?.path;
  if (explicitRoot) return explicitRoot;
  return scan.entries[0]?.path ?? '';
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase();
}
