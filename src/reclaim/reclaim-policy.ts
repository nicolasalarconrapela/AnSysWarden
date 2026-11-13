import type { ScanDocument, ScanEntry } from '../backend/types';

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
  | 'media'
  | 'private'
  | 'application'
  | 'system'
  | 'backup'
  | 'downloads'
  | 'other'
  | 'unknown'
  | 'mixed';

export type ProjectLifecycle = 'active' | 'paused' | 'finished';

export type ReclaimQuestionKind =
  | 'domain'
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
  scopeId: string;
  path: string;
  prompt: string;
  reason: string;
  options: ReclaimQuestionOption[];
}

export interface ReclaimScopeContext {
  id: string;
  path: string;
  name: string;
  domain: ContentDomain;
  domainConfidence: number;
  domainEvidence: string[];
  projectLifecycle?: ProjectLifecycle;
}

export interface ReclaimContext {
  domain: ContentDomain;
  domainConfidence: number;
  domainEvidence: string[];
  scopes: ReclaimScopeContext[];
  projectLifecycle?: ProjectLifecycle;
}

export interface ReclaimPolicyInput {
  projectLifecycle?: ProjectLifecycle;
  answers?: Record<string, string>;
}

export interface ReclaimPolicyState {
  context: ReclaimContext;
  questions: ReclaimQuestion[];
}

interface ScopeCandidate {
  id: string;
  root: ScanEntry;
  entries: ScanEntry[];
}

interface DomainDetection {
  domain: Exclude<ContentDomain, 'mixed'>;
  confidence: number;
  evidence: string[];
}

const DOMAIN_OPTIONS: ReclaimQuestionOption[] = [
  { value: 'development', label: 'DESARROLLO · proyecto, repositorio, código o compilaciones' },
  { value: 'game', label: 'JUEGOS · instalación, partidas, mods o cachés de juegos' },
  { value: 'media', label: 'MEDIA · fotos, vídeos, audio o biblioteca multimedia' },
  { value: 'private', label: 'PRIVADO · documentos o datos personales importantes' },
  { value: 'application', label: 'APLICACIÓN · datos o instalación de una aplicación' },
  { value: 'system', label: 'SISTEMA · archivos del sistema operativo o servicios' },
  { value: 'backup', label: 'BACKUP · copia de seguridad o recuperación' },
  { value: 'downloads', label: 'DESCARGAS · contenido descargado pendiente de clasificar' },
  { value: 'other', label: 'OTRO · no encaja en las categorías anteriores' },
];

export function buildReclaimPolicyState(
  scan: ScanDocument,
  input: ReclaimPolicyInput = {},
): ReclaimPolicyState {
  const scopeCandidates = segmentScopes(scan);
  const questions: ReclaimQuestion[] = [];
  const scopes: ReclaimScopeContext[] = [];

  for (const scope of scopeCandidates) {
    const detected = detectDomain(scope);
    const domainQuestionId = `domain:${scan.id}:${scope.id}`;
    const answeredDomain = normalizeDomainAnswer(input.answers?.[domainQuestionId]);
    const domain = answeredDomain ?? detected.domain;
    const domainConfidence = answeredDomain ? 1 : detected.confidence;
    const domainEvidence = answeredDomain
      ? [`user-confirmed:${answeredDomain}`]
      : detected.evidence;

    if (domain === 'unknown') {
      questions.push({
        id: domainQuestionId,
        kind: 'domain',
        scopeId: scope.id,
        path: scope.root.path,
        prompt: `¿Qué tipo de contenido es "${displayName(scope.root.path)}"?`,
        reason: 'No hay evidencia suficiente para aplicar una política segura a esta parte del árbol.',
        options: DOMAIN_OPTIONS,
      });

      scopes.push({
        id: scope.id,
        path: scope.root.path,
        name: displayName(scope.root.path),
        domain,
        domainConfidence,
        domainEvidence,
      });
      continue;
    }

    let projectLifecycle: ProjectLifecycle | undefined;
    if (domain === 'development') {
      const lifecycleQuestionId = `project-lifecycle:${scan.id}:${scope.id}`;
      const answeredLifecycle = normalizeProjectLifecycle(input.answers?.[lifecycleQuestionId]);
      const singleScopeDefault = scopeCandidates.length === 1 ? input.projectLifecycle : undefined;
      projectLifecycle = answeredLifecycle ?? singleScopeDefault;

      if (!projectLifecycle) {
        questions.push({
          id: lifecycleQuestionId,
          kind: 'project_lifecycle',
          scopeId: scope.id,
          path: scope.root.path,
          prompt: `¿Cuál es el estado del proyecto "${displayName(scope.root.path)}"?`,
          reason: 'Cada proyecto puede tener un ciclo de vida distinto; no se debe aplicar el estado de otro proyecto.',
          options: [
            { value: 'active', label: 'Sigo trabajando en este proyecto' },
            { value: 'paused', label: 'Este proyecto está pausado temporalmente' },
            { value: 'finished', label: 'He terminado con este proyecto' },
          ],
        });
      }
    }

    scopes.push({
      id: scope.id,
      path: scope.root.path,
      name: displayName(scope.root.path),
      domain,
      domainConfidence,
      domainEvidence,
      ...(projectLifecycle ? { projectLifecycle } : {}),
    });
  }

  return {
    context: aggregateContext(scopes),
    questions,
  };
}

function segmentScopes(scan: ScanDocument): ScopeCandidate[] {
  const byId = new Map<string, ScanEntry>();
  const children = new Map<string, ScanEntry[]>();
  const roots: ScanEntry[] = [];

  for (const entry of scan.entries) {
    if (entry.entryId) byId.set(entry.entryId, entry);
  }

  for (const entry of scan.entries) {
    if (entry.parentId && byId.has(entry.parentId)) {
      const siblings = children.get(entry.parentId) ?? [];
      siblings.push(entry);
      children.set(entry.parentId, siblings);
    } else {
      roots.push(entry);
    }
  }

  if (roots.length !== 1) {
    return roots.map((root, index) => makeScope(root, `root-${index + 1}`, children));
  }

  const root = roots[0];
  const rootScope = makeScope(root, root.entryId ?? 'root', children);
  const rootDomain = detectDomain(rootScope);

  // Si la raíz completa ya representa una unidad reconocible (por ejemplo un
  // proyecto con .git + target), no la fragmentamos por sus carpetas internas.
  if (rootDomain.domain !== 'unknown' && rootDomain.confidence >= 0.7) {
    return [rootScope];
  }

  if (!root.entryId) return [rootScope];

  const directChildren = children.get(root.entryId) ?? [];
  if (directChildren.length <= 1) return [rootScope];

  const childScopes = directChildren.map((child, index) =>
    makeScope(child, child.entryId ?? `child-${index + 1}`, children));
  const identifiableChildren = childScopes.filter((scope) => {
    const detected = detectDomain(scope);
    return detected.domain !== 'unknown' && detected.confidence >= 0.7;
  });

  // Solo tratamos los hijos como ámbitos independientes cuando la raíz es un
  // contenedor genérico y al menos uno de sus hijos sí puede clasificarse.
  if (identifiableChildren.length > 0) return childScopes;

  return [rootScope];
}

function makeScope(
  root: ScanEntry,
  fallbackId: string,
  children: Map<string, ScanEntry[]>,
): ScopeCandidate {
  return {
    id: sanitizeScopeId(root.entryId ?? fallbackId),
    root,
    entries: collectSubtree(root, children),
  };
}

function collectSubtree(root: ScanEntry, children: Map<string, ScanEntry[]>): ScanEntry[] {
  const result: ScanEntry[] = [];
  const visit = (entry: ScanEntry): void => {
    result.push(entry);
    if (!entry.entryId) return;
    for (const child of children.get(entry.entryId) ?? []) visit(child);
  };
  visit(root);
  return result;
}

function detectDomain(scope: ScopeCandidate): DomainDetection {
  const paths = scope.entries.map((entry) => normalizePath(entry.path));
  const rootPath = normalizePath(scope.root.path);
  const evidence: string[] = [];

  const hasGit = paths.some((path) => /(^|\/)\.git(\/|$)/i.test(path));
  const buildSignals: string[] = [];
  if (paths.some((path) => /(^|\/)target(\/|$)/i.test(path))) buildSignals.push('cargo-target');
  if (paths.some((path) => /(^|\/)node_modules(\/|$)/i.test(path))) buildSignals.push('node-modules');
  if (paths.some((path) => /(^|\/)\.gradle(\/|$)/i.test(path))) buildSignals.push('gradle');
  if (paths.some((path) => /(^|\/)(\.venv|venv)(\/|$)/i.test(path))) buildSignals.push('python-venv');

  if (hasGit && buildSignals.length > 0) {
    return { domain: 'development', confidence: 0.95, evidence: ['git-repository', ...buildSignals] };
  }
  if (hasGit) {
    return { domain: 'development', confidence: 0.82, evidence: ['git-repository'] };
  }

  if (/(^|\/)(steamapps\/common|games|juegos)(\/|$)/i.test(rootPath)
    || paths.some((path) => /(^|\/)(savegames?|partidas|mods|shadercache)(\/|$)/i.test(path))) {
    evidence.push('game-structure');
    return { domain: 'game', confidence: 0.78, evidence };
  }

  if (/(^|\/)(photos?|fotos|pictures|dcim|videos?|movies|music|audio|media)(\/|$)/i.test(rootPath)
    || paths.some((path) => /(^|\/)(photos?|fotos|pictures|dcim|videos?|movies|music|audio)(\/|$)/i.test(path))) {
    evidence.push('media-structure');
    return { domain: 'media', confidence: 0.82, evidence };
  }

  if (/(^|\/)(documents?|documentos|private|privado|personal)(\/|$)/i.test(rootPath)) {
    return { domain: 'private', confidence: 0.82, evidence: ['private-data-path'] };
  }

  if (/(^|\/)(backup|backups|copias?|respaldo|respaldos)(\/|$)/i.test(rootPath)) {
    return { domain: 'backup', confidence: 0.9, evidence: ['backup-path'] };
  }

  if (/(^|\/)(downloads?|descargas)(\/|$)/i.test(rootPath)) {
    return { domain: 'downloads', confidence: 0.9, evidence: ['downloads-path'] };
  }

  if (/(^|\/)(windows|system32|winsxs|programdata)(\/|$)/i.test(rootPath)) {
    return { domain: 'system', confidence: 0.9, evidence: ['system-path'] };
  }

  if (/(^|\/)(program files|program files \(x86\)|appdata\/local\/programs)(\/|$)/i.test(rootPath)) {
    return { domain: 'application', confidence: 0.8, evidence: ['application-path'] };
  }

  return { domain: 'unknown', confidence: 0, evidence: [] };
}

function aggregateContext(scopes: ReclaimScopeContext[]): ReclaimContext {
  if (scopes.length === 0) {
    return {
      domain: 'unknown',
      domainConfidence: 0,
      domainEvidence: [],
      scopes: [],
    };
  }

  if (scopes.length === 1) {
    const scope = scopes[0];
    return {
      domain: scope.domain,
      domainConfidence: scope.domainConfidence,
      domainEvidence: scope.domainEvidence,
      scopes,
      ...(scope.projectLifecycle ? { projectLifecycle: scope.projectLifecycle } : {}),
    };
  }

  const domains = new Set(scopes.map((scope) => scope.domain));
  const domain = domains.size === 1 ? scopes[0].domain : 'mixed';
  const confidence = scopes.reduce((sum, scope) => sum + scope.domainConfidence, 0) / scopes.length;

  return {
    domain,
    domainConfidence: confidence,
    domainEvidence: [`scopes:${scopes.length}`],
    scopes,
  };
}

function normalizeDomainAnswer(value: unknown): Exclude<ContentDomain, 'unknown' | 'mixed'> | undefined {
  if (typeof value !== 'string') return undefined;
  if ([
    'development',
    'game',
    'media',
    'private',
    'application',
    'system',
    'backup',
    'downloads',
    'other',
  ].includes(value)) {
    return value as Exclude<ContentDomain, 'unknown' | 'mixed'>;
  }
  return undefined;
}

function normalizeProjectLifecycle(value: unknown): ProjectLifecycle | undefined {
  return value === 'active' || value === 'paused' || value === 'finished' ? value : undefined;
}

function sanitizeScopeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'scope';
}

function displayName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase();
}
