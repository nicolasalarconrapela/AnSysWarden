import { opendir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { classifyByRules } from './rules';
import { decideAiTreeEntry } from './tree-policy';
import { ProjectContextEngine } from './project-context';
import { collectEcosystemLabels, decideByEcosystem, detectEcosystems, type EcosystemDetection } from './ecosystem-detector';
import { detectLanguagesWithEnry } from './enry-client';
import { AI_INPUT_SCHEMA, type AiCandidateEntry, type AiInputDocument, type AiOmittedEntry, type AiResolvedEntry } from './tree-types';
import type { ScanDocument, ScanEntry } from '../backend/types';

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ENTRIES = 2_000;
const MAX_OMITTED_DETAILS = 500;

export interface AiTreeOptions {
  maxDepth?: number;
  maxEntries?: number;
}

export class AiTreePruner {
  async build(scan: ScanDocument, inputRoot: string, options: AiTreeOptions = {}): Promise<AiInputDocument> {
    const root = resolve(inputRoot);
    const maxDepth = clampPositive(options.maxDepth ?? DEFAULT_MAX_DEPTH, 1, 32);
    const maxEntries = clampPositive(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 10, 50_000);
    const sizeIndex = buildSizeIndex(scan.entries);
    const omitted: AiOmittedEntry[] = [];
    const omittedByKind: Record<string, number> = {};
    const resolvedLocally: AiResolvedEntry[] = [];
    const candidates: AiCandidateEntry[] = [];
    const lines: string[] = [basename(root) || root];
    const context = new ProjectContextEngine(root);
    const ecosystemCache = new Map<string, EcosystemDetection[]>();
    let visibleEntries = 0;
    let omittedEntries = 0;
    let skippedEntries = 0;
    let truncated = false;
    let omittedListTruncated = false;

    const ecosystemsFor = async (directory: string): Promise<EcosystemDetection[]> => {
      const key = normalizePath(directory);
      const cached = ecosystemCache.get(key);
      if (cached) return cached;
      const detected = await detectEcosystems(directory);
      ecosystemCache.set(key, detected);
      return detected;
    };

    const recordOmitted = (entry: AiOmittedEntry): void => {
      omittedEntries += 1;
      omittedByKind[entry.kind] = (omittedByKind[entry.kind] ?? 0) + 1;
      if (omitted.length < MAX_OMITTED_DETAILS) omitted.push(entry);
      else omittedListTruncated = true;
    };

    const omit = (fullPath: string, name: string, kind: AiOmittedEntry['kind'], reason: string): void => {
      const local = classifyByRules(fullPath);
      const scanEntry = findScanEntry(sizeIndex, fullPath);
      recordOmitted({
        path: fullPath,
        name,
        kind,
        reason,
        ...(scanEntry ? { sizeBytes: scanEntry.sizeBytes } : {}),
        ...(local ? { classification: local.classification, classificationSource: local.source } : {}),
      });
    };

    const walk = async (directory: string, depth: number, prefix: string): Promise<void> => {
      if (truncated) return;
      if (depth >= maxDepth) {
        recordOmitted({ path: directory, name: basename(directory), kind: 'DEPTH_LIMIT', reason: `Profundidad máxima del árbol IA alcanzada (${maxDepth}).` });
        return;
      }

      let handle;
      try {
        handle = await opendir(directory);
      } catch (error) {
        skippedEntries += 1;
        recordOmitted({
          path: directory,
          name: basename(directory),
          kind: 'ACCESS_ERROR',
          reason: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const directoryEcosystems = await ecosystemsFor(directory);
      const entries = [];
      for await (const entry of handle) entries.push(entry);
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

      for (let index = 0; index < entries.length; index += 1) {
        if (visibleEntries >= maxEntries) {
          truncated = true;
          lines.push(`${prefix}└── … [árbol truncado: límite ${maxEntries}]`);
          return;
        }

        const entry = entries[index];
        const fullPath = join(directory, entry.name);
        const isLast = index === entries.length - 1;
        const branch = isLast ? '└── ' : '├── ';
        const childPrefix = `${prefix}${isLast ? '    ' : '│   '}`;

        if (entry.isSymbolicLink()) {
          recordOmitted({ path: fullPath, name: entry.name, kind: 'SYMLINK', reason: 'Enlace simbólico omitido; AnSysWarden no lo sigue.' });
          continue;
        }

        const isDirectory = entry.isDirectory();

        // Seguridad explícita y conocimiento local de AnSysWarden tienen la
        // prioridad más alta. Esto incluye secretos y reglas conservadoras.
        const localTreeDecision = decideAiTreeEntry(fullPath, isDirectory);
        if (localTreeDecision.policy === 'DROP') {
          omit(fullPath, entry.name, localTreeDecision.kind, localTreeDecision.reason);
          continue;
        }

        // El propio proyecto es la siguiente fuente de verdad: .gitattributes
        // (Linguist) y .gitignore. Ignorar para IA nunca equivale a borrar.
        const projectDecision = await context.decide(fullPath, isDirectory);
        if (projectDecision) {
          omit(fullPath, entry.name, projectDecision.kind, `${projectDecision.reason} No concede permiso de borrado.`);
          continue;
        }

        // Los manifests del directorio dan contexto: target dentro de Rust,
        // vendor dentro de Go/PHP, etc. Evita depender solo del nombre.
        const ecosystemDecision = decideByEcosystem(fullPath, isDirectory, directoryEcosystems);
        if (ecosystemDecision) {
          omit(fullPath, entry.name, ecosystemDecision.kind, `${ecosystemDecision.reason} No concede permiso de borrado.`);
          continue;
        }

        visibleEntries += 1;
        lines.push(`${prefix}${branch}${entry.name}${isDirectory ? '/' : ''}`);
        if (isDirectory) await walk(fullPath, depth + 1, childPrefix);
      }
    };

    await walk(root, 0, '');

    // Las entradas grandes de Dust pasan por el mismo router antes de poder
    // convertirse en candidatos para Gemma.
    for (const entry of scan.entries) {
      const local = classifyByRules(entry.path);
      if (local) {
        resolvedLocally.push({ ...entry, ...local, path: entry.path, sizeBytes: entry.sizeBytes });
        continue;
      }

      const treeDecision = decideAiTreeEntry(entry.path, true);
      if (treeDecision.policy === 'DROP') continue;

      const projectDecision = await context.decide(entry.path, true);
      if (projectDecision) continue;

      const parentEcosystems = await ecosystemsFor(dirname(entry.path));
      if (decideByEcosystem(entry.path, true, parentEcosystems)) continue;

      if (isActionableScanEntry(entry, root)) {
        candidates.push({
          ...(entry.entryId ? { entryId: entry.entryId } : {}),
          ...(entry.parentId ? { parentId: entry.parentId } : {}),
          ...(entry.depth !== undefined ? { depth: entry.depth } : {}),
          path: entry.path,
          sizeBytes: entry.sizeBytes,
        });
      }
    }

    const [ecosystems, enry] = await Promise.all([
      collectEcosystemLabels(root),
      detectLanguagesWithEnry(root),
    ]);

    return {
      schema: AI_INPUT_SCHEMA,
      scanId: scan.id,
      createdAt: new Date().toISOString(),
      root,
      tree: lines.join('\n'),
      summary: {
        visibleEntries,
        omittedEntries,
        skippedEntries,
        maxDepth,
        maxEntries,
        truncated,
        omittedListTruncated,
        omittedByKind,
        resolvedLocally: resolvedLocally.length,
        aiCandidates: candidates.length,
        ecosystems,
        languages: enry.languages,
        enryAvailable: enry.available,
      },
      resolvedLocally,
      candidates,
      omitted,
    };
  }
}

function buildSizeIndex(entries: ScanEntry[]): Map<string, ScanEntry> {
  const index = new Map<string, ScanEntry>();
  for (const entry of entries) index.set(normalizePath(entry.path), entry);
  return index;
}

function findScanEntry(index: Map<string, ScanEntry>, path: string): ScanEntry | undefined {
  return index.get(normalizePath(path));
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isActionableScanEntry(entry: ScanEntry, root: string): boolean {
  const normalized = normalizePath(entry.path);
  const rootNormalized = normalizePath(root);
  if (normalized === rootNormalized) return false;

  const relative = normalized.startsWith(`${rootNormalized}/`)
    ? normalized.slice(rootNormalized.length + 1)
    : normalized;
  const segments = relative.split('/').filter(Boolean);

  // Los contenedores superiores sirven para calcular tamaño/jerarquía, no son
  // una pregunta útil para Gemma (por ejemplo AppData o el propio HOME).
  return segments.length >= 2;
}

function clampPositive(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Valor fuera de rango: ${value}. Debe estar entre ${min} y ${max}.`);
  }
  return value;
}
