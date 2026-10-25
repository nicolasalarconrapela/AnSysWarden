import { basename } from 'node:path';
import type { AiTreeKind } from './tree-types';

export const REPOMIX_POLICY_VERSION = '1.18.1';

export interface RepomixDecision {
  kind: AiTreeKind;
  reason: string;
}

// Subconjunto deliberado de los patrones por defecto de Repomix 1.18.1
// (MIT, https://github.com/yamadashy/repomix). Solo usamos reglas de
// visibilidad para IA. NO conceden permiso de borrado. Los manifests y
// lockfiles se conservan porque son señales útiles para detectar ecosistema.
const DIRECTORY_RULES: Array<{ pattern: RegExp; kind: AiTreeKind; reason: string }> = [
  { pattern: /^(\.git|\.hg|\.svn)$/i, kind: 'VCS_INTERNAL', reason: 'Metadatos de control de versiones omitidos por la política de contexto.' },
  { pattern: /^(node_modules|bower_components|jspm_packages)$/i, kind: 'NODE_DEPENDENCIES', reason: 'Dependencias instaladas: Repomix las excluye del contexto de código.' },
  { pattern: /^(vendor|\.bundle)$/i, kind: 'VENDORED', reason: 'Código o dependencias vendorizadas: se omiten del árbol IA.' },
  { pattern: /^(\.gradle|\.m2|\.npm|\.yarn)$/i, kind: 'TOOL_CACHE', reason: 'Estado/caché local de herramientas excluido del contexto IA.' },
  { pattern: /^(\.next|\.nuxt|\.serverless)$/i, kind: 'BUILD_OUTPUT', reason: 'Salida generada por framework: no aporta estructura fuente.' },
  { pattern: /^(dist|build|out|target)$/i, kind: 'BUILD_OUTPUT', reason: 'Salida de compilación/generación omitida del árbol IA.' },
  { pattern: /^(tmp|temp)$/i, kind: 'TOOL_CACHE', reason: 'Directorio temporal omitido del árbol IA.' },
  { pattern: /^(\.parcel-cache|\.sass-cache|\.rollup\.cache|\.webpack\.cache)$/i, kind: 'TOOL_CACHE', reason: 'Caché de herramienta de frontend omitida del árbol IA.' },
  { pattern: /^(__pycache__|\.pytest_cache|\.mypy_cache|\.ipynb_checkpoints)$/i, kind: 'TOOL_CACHE', reason: 'Caché Python omitida del árbol IA.' },
  { pattern: /^(venv|\.venv)$/i, kind: 'PYTHON_ENV', reason: 'Entorno virtual Python omitido del contexto IA.' },
  { pattern: /^(coverage|\.nyc_output|htmlcov)$/i, kind: 'TEST_OUTPUT', reason: 'Salida de cobertura/pruebas omitida del contexto IA.' },
  { pattern: /^(\.idea|\.vscode)$/i, kind: 'IDE_INTERNAL', reason: 'Metadatos del IDE omitidos del contexto IA.' },
];

const FILE_RULES: Array<{ pattern: RegExp; kind: AiTreeKind; reason: string }> = [
  { pattern: /\.(?:log|bak|swp|swo|swn)$/i, kind: 'TOOL_CACHE', reason: 'Log/backup temporal omitido del contexto IA.' },
  { pattern: /^(?:\.DS_Store|Thumbs\.db)$/i, kind: 'SYSTEM_APP_DATA', reason: 'Metadato del sistema operativo omitido del contexto IA.' },
  { pattern: /\.py[cod]$/i, kind: 'TOOL_CACHE', reason: 'Bytecode Python omitido del contexto IA.' },
];

export function decideByRepomixPolicy(fullPath: string, isDirectory: boolean): RepomixDecision | null {
  const name = basename(fullPath);
  const rules = isDirectory ? DIRECTORY_RULES : FILE_RULES;
  for (const rule of rules) {
    if (rule.pattern.test(name)) return { kind: rule.kind, reason: rule.reason };
  }
  return null;
}
