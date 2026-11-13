import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { AiTreeKind } from './tree-types';

interface IgnoreRule {
  baseDir: string;
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
}

interface AttributeRule {
  baseDir: string;
  pattern: string;
  attributes: string[];
}

export interface ProjectContextDecision {
  kind: AiTreeKind;
  reason: string;
}

export class ProjectContextEngine {
  private readonly ignoreCache = new Map<string, IgnoreRule[]>();
  private readonly attributesCache = new Map<string, AttributeRule[]>();

  constructor(private readonly root: string) {}

  async decide(fullPath: string, isDirectory: boolean): Promise<ProjectContextDecision | null> {
    const normalizedRoot = resolve(this.root);
    const normalizedPath = resolve(fullPath);
    if (!isInside(normalizedRoot, normalizedPath)) return null;

    const directories = ancestry(normalizedRoot, dirname(normalizedPath));
    let ignored = false;

    for (const directory of directories) {
      for (const rule of await this.loadIgnoreRules(directory)) {
        if (matchesProjectRule(rule.baseDir, normalizedPath, rule.pattern, isDirectory, rule.directoryOnly)) {
          ignored = !rule.negated;
        }
      }
    }

    for (const directory of directories) {
      for (const rule of await this.loadAttributeRules(directory)) {
        if (!matchesProjectRule(rule.baseDir, normalizedPath, rule.pattern, isDirectory, false)) continue;
        const attrs = new Set(rule.attributes.map((item) => item.toLowerCase()));

        if (attrs.has('linguist-generated')) {
          return { kind: 'GENERATED', reason: 'The path is marked as linguist-generated in .gitattributes.' };
        }
        if (attrs.has('linguist-vendored')) {
          return { kind: 'VENDORED', reason: 'The path is marked as linguist-vendored in .gitattributes.' };
        }
        if (attrs.has('linguist-documentation')) {
          return { kind: 'DOCUMENTATION', reason: 'The path is marked as linguist-documentation in .gitattributes.' };
        }
        if (attrs.has('-linguist-detectable') || attrs.has('linguist-detectable=false')) {
          return { kind: 'OTHER', reason: 'The path is excluded from Linguist detection through .gitattributes.' };
        }
      }
    }

    if (ignored) {
      return { kind: 'GIT_IGNORED', reason: 'The path matches an active .gitignore rule from the project itself.' };
    }

    return null;
  }

  private async loadIgnoreRules(directory: string): Promise<IgnoreRule[]> {
    const cached = this.ignoreCache.get(directory);
    if (cached) return cached;
    const rules = await readRulesFile(resolve(directory, '.gitignore'), (line) => parseIgnoreRule(directory, line));
    this.ignoreCache.set(directory, rules);
    return rules;
  }

  private async loadAttributeRules(directory: string): Promise<AttributeRule[]> {
    const cached = this.attributesCache.get(directory);
    if (cached) return cached;
    const rules = await readRulesFile(resolve(directory, '.gitattributes'), (line) => parseAttributeRule(directory, line));
    this.attributesCache.set(directory, rules);
    return rules;
  }
}

async function readRulesFile<T>(path: string, parse: (line: string) => T | null): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const rules: T[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parsed = parse(line);
    if (parsed) rules.push(parsed);
  }
  return rules;
}

function parseIgnoreRule(baseDir: string, line: string): IgnoreRule | null {
  let pattern = line;
  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  }
  if (!pattern) return null;
  const directoryOnly = pattern.endsWith('/');
  if (directoryOnly) pattern = pattern.slice(0, -1);
  return { baseDir, pattern, negated, directoryOnly };
}

function parseAttributeRule(baseDir: string, line: string): AttributeRule | null {
  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { baseDir, pattern: parts[0], attributes: parts.slice(1) };
}

function matchesProjectRule(
  baseDir: string,
  fullPath: string,
  pattern: string,
  isDirectory: boolean,
  directoryOnly: boolean,
): boolean {
  if (directoryOnly && !isDirectory) return false;
  const rel = normalize(relative(baseDir, fullPath));
  if (!rel || rel.startsWith('../')) return false;

  const anchored = pattern.startsWith('/');
  const cleaned = normalize(pattern.replace(/^\//, ''));
  const regex = globToRegExp(cleaned, anchored || cleaned.includes('/'));
  return regex.test(rel);
}

function globToRegExp(pattern: string, pathAware: boolean): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegex(char);
  }

  if (pathAware) return new RegExp(`^${source}(?:/.*)?$`, process.platform === 'win32' ? 'i' : '');
  return new RegExp(`(?:^|/)${source}(?:/.*)?$`, process.platform === 'win32' ? 'i' : '');
}

function ancestry(root: string, leaf: string): string[] {
  const result: string[] = [];
  let current = leaf;
  while (isInside(root, current)) {
    result.unshift(current);
    if (samePath(current, root)) break;
    const parent = dirname(current);
    if (samePath(parent, current)) break;
    current = parent;
  }
  if (result.length === 0 || !samePath(result[0], root)) result.unshift(root);
  return [...new Set(result)];
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/');
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
