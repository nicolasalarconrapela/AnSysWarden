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
        recordOmitted({ path: directory, name: basename(directory), kind: 'DEPTH_LIMIT', reason: `Maximum AI-tree depth reached (${maxDepth}).` });
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
          lines.push(`${prefix}└── … [tree truncated: limit ${maxEntries}]`);
          return;
        }

        const entry = entries[index];
        const fullPath = join(directory, entry.name);
        const isLast = index === entries.length - 1;
        const branch = isLast ? '└── ' : '├── ';
        const childPrefix = `${prefix}${isLast ? '    ' : '│   '}`;

        if (entry.isSymbolicLink()) {
          recordOmitted({ path: fullPath, name: entry.name, kind: 'SYMLINK', reason: 'Symbolic link omitted; AnSysWarden never follows it.' });
          continue;
        }

        const isDirectory = entry.isDirectory();

        // Explicit safety and AnSysWarden's local knowledge have the highest
        // priority. This includes secret files and conservative local rules.
        const localTreeDecision = decideAiTreeEntry(fullPath, isDirectory);
        if (localTreeDecision.policy === 'DROP') {
          omit(fullPath, entry.name, localTreeDecision.kind, localTreeDecision.reason);
          continue;
        }

        // The project itself is the next source of truth: .gitattributes
        // (Linguist) and .gitignore. Hiding something from AI never means delete it.
        const projectDecision = await context.decide(fullPath, isDirectory);
        if (projectDecision) {
          omit(fullPath, entry.name, projectDecision.kind, `${projectDecision.reason} This never grants deletion permission.`);
          continue;
        }

        // Directory manifests provide context: target inside Rust,
        // vendor inside Go/PHP, etc. This avoids relying only on names.
        const ecosystemDecision = decideByEcosystem(fullPath, isDirectory, directoryEcosystems);
        if (ecosystemDecision) {
          omit(fullPath, entry.name, ecosystemDecision.kind, `${ecosystemDecision.reason} This never grants deletion permission.`);
          continue;
        }

        visibleEntries += 1;
        lines.push(`${prefix}${branch}${entry.name}${isDirectory ? '/' : ''}`);
        if (isDirectory) await walk(fullPath, depth + 1, childPrefix);
      }
    };

    await walk(root, 0, '');

    // Large Dust entries go through the same router before they can become
    // Gemma candidates. A known project root is structural and is never proposed
    // as a whole; an unknown large directory may still become a candidate.
    for (const entry of scan.entries) {
      if (samePath(entry.path, root)) continue;

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

      // If the directory itself contains recognizable manifests, it is a project
      // root (Node, Rust, Python, etc.), not a cleanup candidate.
      const ownEcosystems = await ecosystemsFor(entry.path);
      if (ownEcosystems.length > 0) continue;

      candidates.push({
        ...(entry.entryId ? { entryId: entry.entryId } : {}),
        ...(entry.parentId ? { parentId: entry.parentId } : {}),
        ...(entry.depth !== undefined ? { depth: entry.depth } : {}),
        path: entry.path,
        sizeBytes: entry.sizeBytes,
        reason: 'Large directory detected by Dust that no local rule or project context could explain.',
        ecosystems: parentEcosystems.map((item) => item.ecosystem),
      });
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

function samePath(a: string, b: string): boolean {
  return normalizePath(resolve(a)) === normalizePath(resolve(b));
}

function clampPositive(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Value out of range: ${value}. It must be between ${min} and ${max}.`);
  }
  return value;
}
