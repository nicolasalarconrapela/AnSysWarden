import { basename } from 'node:path';
import { decideByRepomixPolicy } from './repomix-policy';
import type { AiTreeKind, AiTreePolicy } from './tree-types';

export interface AiTreeDecision {
  policy: AiTreePolicy;
  kind: AiTreeKind;
  reason: string;
}

const DROP_DIRECTORIES: Array<{ pattern: RegExp; kind: AiTreeKind; reason: string }> = [
  { pattern: /^node_modules$/i, kind: 'NODE_DEPENDENCIES', reason: 'Node.js dependencies: keep the scan node, but hide its internal tree from AI.' },
  { pattern: /^(\.venv|venv|env)$/i, kind: 'PYTHON_ENV', reason: 'Python virtual environment: installed dependencies do not add useful structural context for AI.' },
  { pattern: /^(dist|out|target)$/i, kind: 'BUILD_OUTPUT', reason: 'Build/generated output: omit it from the AI tree without authorizing deletion.' },
  { pattern: /^build$/i, kind: 'BUILD_OUTPUT', reason: 'Build directory: omit it from the AI tree without assuming it is safe to delete.' },
  { pattern: /^\.git$/i, kind: 'VCS_INTERNAL', reason: 'Internal Git metadata: it does not add useful project context for AI.' },
  { pattern: /^(\.gradle|\.m2)$/i, kind: 'TOOL_CACHE', reason: 'Local build-tool state: stop expansion before exposing it to AI.' },
  { pattern: /^(\.cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox)$/i, kind: 'TOOL_CACHE', reason: 'Known local cache: do not expand it in the AI tree.' },
  { pattern: /^(coverage|\.coverage|htmlcov|\.nyc_output)$/i, kind: 'TEST_OUTPUT', reason: 'Coverage/test output: it does not add source-structure context for AI.' },
  { pattern: /^(\.idea|\.vscode|\.aistudio)$/i, kind: 'IDE_INTERNAL', reason: 'Internal IDE or assistant metadata: omit it from the AI tree.' },
];

const SAFE_ENV_TEMPLATES = [
  /^\.env\.example$/i,
  /^\.env\.sample$/i,
  /^\.env\.template$/i,
];

const SENSITIVE_FILES = [
  /^\.env(?:\..+)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^credentials(?:\..+)?$/i,
  /^secrets?(?:\..+)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /^.*\.(?:pem|key|p12|pfx)$/i,
];

export function decideAiTreeEntry(fullPath: string, isDirectory: boolean): AiTreeDecision {
  const name = basename(fullPath);
  const normalized = fullPath.replace(/\\/g, '/');

  if (!isDirectory && SAFE_ENV_TEMPLATES.some((pattern) => pattern.test(name))) {
    return {
      policy: 'KEEP',
      kind: 'SOURCE',
      reason: 'Environment-variable template: keep only its name as structural context.',
    };
  }

  if (!isDirectory && SENSITIVE_FILES.some((pattern) => pattern.test(name))) {
    return {
      policy: 'DROP',
      kind: 'SENSITIVE_FILE',
      reason: 'Potentially sensitive file: its name may be recorded as omitted, but it is never sent in the AI tree.',
    };
  }

  if (isDirectory && /(^|\/)bin\/ctags$/i.test(normalized)) {
    return {
      policy: 'DROP',
      kind: 'TOOL_BUNDLE',
      reason: 'Local Universal Ctags bundle: packaged docs and binaries do not add useful project context for AI.',
    };
  }

  if (isDirectory) {
    for (const rule of DROP_DIRECTORIES) {
      if (rule.pattern.test(name)) {
        return { policy: 'DROP', kind: rule.kind, reason: rule.reason };
      }
    }
  }

  const repomix = decideByRepomixPolicy(fullPath, isDirectory);
  if (repomix) {
    return {
      policy: 'DROP',
      kind: repomix.kind,
      reason: `${repomix.reason} This decision only affects AI visibility; it never authorizes deletion.`,
    };
  }

  return {
    policy: 'KEEP',
    kind: 'SOURCE',
    reason: 'Structural entry kept to provide context for analysis.',
  };
}
