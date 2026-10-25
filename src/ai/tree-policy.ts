import { basename } from 'node:path';
import type { AiTreeKind, AiTreePolicy } from './tree-types';

export interface AiTreeDecision {
  policy: AiTreePolicy;
  kind: AiTreeKind;
  reason: string;
}

const DROP_DIRECTORIES: Array<{ pattern: RegExp; kind: AiTreeKind; reason: string }> = [
  { pattern: /^node_modules$/i, kind: 'NODE_DEPENDENCIES', reason: 'Dependencias Node.js: se conserva el nodo de scan, pero no su árbol interno para la IA.' },
  { pattern: /^(\.venv|venv|env)$/i, kind: 'PYTHON_ENV', reason: 'Entorno virtual Python: sus dependencias instaladas no aportan contexto estructural a la IA.' },
  { pattern: /^(dist|out|target)$/i, kind: 'BUILD_OUTPUT', reason: 'Salida de compilación/generación: se omite del árbol IA sin autorizar su borrado.' },
  { pattern: /^build$/i, kind: 'BUILD_OUTPUT', reason: 'Directorio de build: se omite del árbol IA sin asumir que sea seguro eliminarlo.' },
  { pattern: /^\.git$/i, kind: 'VCS_INTERNAL', reason: 'Metadatos internos de Git: no aportan contexto del proyecto para la IA.' },
  { pattern: /^(\.gradle|\.m2)$/i, kind: 'TOOL_CACHE', reason: 'Estado local de herramientas de build: se corta antes de expandirlo para la IA.' },
  { pattern: /^(\.cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox)$/i, kind: 'TOOL_CACHE', reason: 'Caché local conocida: no se expande en el árbol IA.' },
  { pattern: /^(coverage|\.coverage|htmlcov|\.nyc_output)$/i, kind: 'TEST_OUTPUT', reason: 'Salida de cobertura/pruebas: no aporta estructura fuente a la IA.' },
  { pattern: /^(\.idea|\.vscode|\.aistudio)$/i, kind: 'IDE_INTERNAL', reason: 'Metadatos internos del IDE o asistente: se omiten del árbol IA.' },
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
      reason: 'Plantilla de variables de entorno: se conserva solo su nombre como contexto estructural.',
    };
  }

  if (!isDirectory && SENSITIVE_FILES.some((pattern) => pattern.test(name))) {
    return {
      policy: 'DROP',
      kind: 'SENSITIVE_FILE',
      reason: 'Archivo potencialmente sensible: el nombre puede registrarse como omitido, pero nunca se envía en el árbol para IA.',
    };
  }

  if (isDirectory && /(^|\/)bin\/ctags$/i.test(normalized)) {
    return {
      policy: 'DROP',
      kind: 'TOOL_BUNDLE',
      reason: 'Bundle local de Universal Ctags: documentación y binarios empaquetados no aportan contexto del proyecto para la IA.',
    };
  }

  if (isDirectory) {
    for (const rule of DROP_DIRECTORIES) {
      if (rule.pattern.test(name)) {
        return { policy: 'DROP', kind: rule.kind, reason: rule.reason };
      }
    }
  }

  return {
    policy: 'KEEP',
    kind: 'SOURCE',
    reason: 'Entrada estructural conservada para aportar contexto al análisis.',
  };
}
