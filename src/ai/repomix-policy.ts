import { basename } from 'node:path';
import type { AiTreeKind } from './tree-types';

export const REPOMIX_POLICY_VERSION = '1.18.1';

export interface RepomixDecision {
  kind: AiTreeKind;
  reason: string;
}

// Deliberate subset of Repomix 1.18.1 default patterns
// (MIT, https://github.com/yamadashy/repomix). These rules are used only for
// AI visibility. They NEVER grant deletion permission. Manifests and lockfiles
// remain visible because they are useful ecosystem signals.
const DIRECTORY_RULES: Array<{ pattern: RegExp; kind: AiTreeKind; reason: string }> = [
  { pattern: /^(\.git|\.hg|\.svn)$/i, kind: 'VCS_INTERNAL', reason: 'Version-control metadata omitted by the context policy.' },
  { pattern: /^(node_modules|bower_components|jspm_packages)$/i, kind: 'NODE_DEPENDENCIES', reason: 'Installed dependencies: Repomix excludes them from source-code context.' },
  { pattern: /^(vendor|\.bundle)$/i, kind: 'VENDORED', reason: 'Vendored code or dependencies: omitted from the AI tree.' },
  { pattern: /^(\.gradle|\.m2|\.npm|\.yarn)$/i, kind: 'TOOL_CACHE', reason: 'Local tool state/cache excluded from AI context.' },
  { pattern: /^(\.next|\.nuxt|\.serverless)$/i, kind: 'BUILD_OUTPUT', reason: 'Framework-generated output: it does not add source structure.' },
  { pattern: /^(dist|build|out|target)$/i, kind: 'BUILD_OUTPUT', reason: 'Build/generated output omitted from the AI tree.' },
  { pattern: /^(tmp|temp)$/i, kind: 'TOOL_CACHE', reason: 'Temporary directory omitted from the AI tree.' },
  { pattern: /^(\.parcel-cache|\.sass-cache|\.rollup\.cache|\.webpack\.cache)$/i, kind: 'TOOL_CACHE', reason: 'Frontend tool cache omitted from the AI tree.' },
  { pattern: /^(__pycache__|\.pytest_cache|\.mypy_cache|\.ipynb_checkpoints)$/i, kind: 'TOOL_CACHE', reason: 'Python cache omitted from the AI tree.' },
  { pattern: /^(venv|\.venv)$/i, kind: 'PYTHON_ENV', reason: 'Python virtual environment omitted from AI context.' },
  { pattern: /^(coverage|\.nyc_output|htmlcov)$/i, kind: 'TEST_OUTPUT', reason: 'Coverage/test output omitted from AI context.' },
  { pattern: /^(\.idea|\.vscode)$/i, kind: 'IDE_INTERNAL', reason: 'IDE metadata omitted from AI context.' },
];

const FILE_RULES: Array<{ pattern: RegExp; kind: AiTreeKind; reason: string }> = [
  { pattern: /\.(?:log|bak|swp|swo|swn)$/i, kind: 'TOOL_CACHE', reason: 'Temporary log/backup file omitted from AI context.' },
  { pattern: /^(?:\.DS_Store|Thumbs\.db)$/i, kind: 'SYSTEM_APP_DATA', reason: 'Operating-system metadata omitted from AI context.' },
  { pattern: /\.py[cod]$/i, kind: 'TOOL_CACHE', reason: 'Python bytecode omitted from AI context.' },
];

export function decideByRepomixPolicy(fullPath: string, isDirectory: boolean): RepomixDecision | null {
  const name = basename(fullPath);
  const rules = isDirectory ? DIRECTORY_RULES : FILE_RULES;
  for (const rule of rules) {
    if (rule.pattern.test(name)) return { kind: rule.kind, reason: rule.reason };
  }
  return null;
}
