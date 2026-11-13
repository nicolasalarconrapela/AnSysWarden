import { createReadStream } from 'node:fs';
import { lstat, mkdir, opendir, readlink, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { TreeIndexRecord, TreeScanMetadata } from './native-tree-scanner';
import { resolveTreeInputPath } from './native-tree-scanner';

const DEFAULT_BRANCHES = ['ANDROID_Studio', 'OSS', 'AnSysWarden'];
const MAX_EXAMPLES = 40;

interface Counts {
  files: number;
  directories: number;
  symlinks: number;
  other: number;
  errors: number;
  logicalBytes: number;
}

interface LinkEvidence {
  path: string;
  target?: string;
  targetKind: 'directory' | 'file' | 'broken-or-inaccessible' | 'other';
  classification: 'link-to-directory-candidate-junction' | 'symbolic-link';
}

interface ProblemEvidence {
  path: string;
  code: string;
  message: string;
}

interface SnapshotBranch {
  rootPath: string;
  counts: Counts;
  byDirectory: Map<string, Counts>;
}

export interface AuditBranchReport {
  name: string;
  rootPath: string;
  indexed: Counts;
  live: Counts;
  deltaFiles: number;
  deltaBytes: number;
  topDifferences: Array<{ path: string; indexedFiles: number; liveFiles: number; deltaFiles: number }>;
  links: LinkEvidence[];
  problems: ProblemEvidence[];
}

export interface AuditReport {
  schema: 'ansyswarden.tree-audit.v1';
  generatedAt: string;
  sourceScanId: string;
  sourceScanAt: string;
  sourceIndex: string;
  scopeRoot: string;
  methodology: string;
  branches: AuditBranchReport[];
  totals: { indexedFiles: number; liveFiles: number; deltaFiles: number };
  limitations: string[];
}

function emptyCounts(): Counts {
  return { files: 0, directories: 0, symlinks: 0, other: 0, errors: 0, logicalBytes: 0 };
}

function add(into: Counts, from: Counts): void {
  into.files += from.files;
  into.directories += from.directories;
  into.symlinks += from.symlinks;
  into.other += from.other;
  into.errors += from.errors;
  into.logicalBytes += from.logicalBytes;
}

function isInside(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === '' || (diff !== '..' && !diff.startsWith('..' + sep) && !diff.startsWith(sep));
}

function directChildPath(root: string, candidate: string): string {
  const rel = relative(root, candidate);
  if (!rel || rel === '.') return root;
  const first = rel.split(sep)[0];
  return join(root, first);
}

function recordCount(record: TreeIndexRecord): Counts {
  const counts = emptyCounts();
  if (record.record === 'error') {
    counts.errors = 1;
  } else if (record.record === 'entry') {
    if (record.type === 'file') counts.files = 1;
    else if (record.type === 'directory') counts.directories = 1;
    else if (record.type === 'symlink') counts.symlinks = 1;
    else counts.other = 1;
    if (record.type !== 'directory') counts.logicalBytes = record.sizeBytes;
  }
  return counts;
}

async function indexBranches(
  indexPath: string,
  names: string[],
  rootPath: string,
): Promise<SnapshotBranch[]> {
  const input = createReadStream(indexPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const candidates = new Map<string, string[]>();
  const records: TreeIndexRecord[] = [];

  // La búsqueda de raíces se hace por nombre exacto, no por prefijo.
  // El índice actual está pensado para cientos de miles de entradas.
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as TreeIndexRecord;
    if (record.record === 'directory-summary') continue;
    records.push(record);
    if (record.record === 'entry' && record.type === 'directory' && names.includes(record.name)
        && isInside(rootPath, record.path)) {
      const found = candidates.get(record.name) ?? [];
      found.push(record.path);
      candidates.set(record.name, found);
    }
  }

  return names.map(name => {
    const matches = candidates.get(name) ?? [];
    // Prioriza la rama de menor profundidad; si el nombre está duplicado,
    // se registra una advertencia en el CLI en lugar de mezclar ambas.
    const root = matches.sort((a, b) =>
      a.split(sep).length - b.split(sep).length || a.localeCompare(b))[0] ?? '';
    const branch: SnapshotBranch = { rootPath: root, counts: emptyCounts(), byDirectory: new Map() };
    if (!root) return branch;

    for (const record of records) {
      if (record.record === 'directory-summary') continue;
      if (!isInside(root, record.path)) continue;
      const count = recordCount(record);
      add(branch.counts, count);
      const key = directChildPath(root, record.path);
      let sub = branch.byDirectory.get(key);
      if (!sub) { sub = emptyCounts(); branch.byDirectory.set(key, sub); }
      add(sub, count);
    }
    return branch;
  });
}

async function liveBranch(root: string): Promise<{
  counts: Counts;
  byDirectory: Map<string, Counts>;
  links: LinkEvidence[];
  problems: ProblemEvidence[];
}> {
  const counts = emptyCounts();
  const byDirectory = new Map<string, Counts>();
  const links: LinkEvidence[] = [];
  const problems: ProblemEvidence[] = [];
  const pending = [root];

  while (pending.length) {
    const path = pending.pop()!;
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      counts.errors++;
      if (problems.length < MAX_EXAMPLES) {
        const err = error as NodeJS.ErrnoException;
        problems.push({ path, code: err.code ?? 'ERROR', message: err.message ?? String(error) });
      }
      continue;
    }

    const local = emptyCounts();
    if (info.isSymbolicLink()) {
      local.symlinks++;
      local.logicalBytes += Math.max(0, info.size);
      if (links.length < MAX_EXAMPLES) {
        let target: string | undefined;
        let targetKind: LinkEvidence['targetKind'] = 'broken-or-inaccessible';
        try { target = await readlink(path); } catch { /* evidencia opcional */ }
        try {
          const followed = await stat(path); // Solo inspecciona el destino; NO se recorre.
          targetKind = followed.isDirectory() ? 'directory' : followed.isFile() ? 'file' : 'other';
        } catch { /* enlace roto o destino inaccesible */ }
        links.push({
          path,
          ...(target ? { target } : {}),
          targetKind,
          classification: targetKind === 'directory'
            ? 'link-to-directory-candidate-junction'
            : 'symbolic-link',
        });
      }
    } else if (info.isDirectory()) {
      local.directories++;
      try {
        const dir = await opendir(path);
        for await (const item of dir) pending.push(join(path, item.name));
      } catch (error) {
        local.errors++;
        if (problems.length < MAX_EXAMPLES) {
          const err = error as NodeJS.ErrnoException;
          problems.push({ path, code: err.code ?? 'ERROR', message: err.message ?? String(error) });
        }
      }
    } else if (info.isFile()) {
      local.files++;
      local.logicalBytes += Math.max(0, info.size);
    } else {
      local.other++;
      local.logicalBytes += Math.max(0, info.size);
    }

    add(counts, local);
    const key = directChildPath(root, path);
    const part = byDirectory.get(key) ?? emptyCounts();
    add(part, local);
    byDirectory.set(key, part);
  }
  return { counts, byDirectory, links, problems };
}

export async function runTreeAudit(
  metadata: TreeScanMetadata,
  options: { branchNames?: string[]; outputPath?: string } = {},
): Promise<{ report: AuditReport; outputPath: string }> {
  const names = options.branchNames ?? DEFAULT_BRANCHES;
  if (!names.length || names.some(value => !value || value.includes('/') || value.includes('\\'))) {
    throw new Error('Las ramas deben ser nombres de carpeta separados por comas, sin rutas.');
  }
  const rootPath = resolveTreeInputPath(metadata.rootPath);
  const indexed = await indexBranches(metadata.indexPath, names, rootPath);
  const branches: AuditBranchReport[] = [];

  for (let index = 0; index < names.length; index++) {
    const branch = indexed[index];
    if (!branch.rootPath) {
      throw new Error('No se encontró la rama "' + names[index] + '" en el índice ' + metadata.indexPath);
    }
    const live = await liveBranch(branch.rootPath);
    const allChildren = new Set([...branch.byDirectory.keys(), ...live.byDirectory.keys()]);
    const diffs = [...allChildren].map(path => ({
      path,
      indexedFiles: branch.byDirectory.get(path)?.files ?? 0,
      liveFiles: live.byDirectory.get(path)?.files ?? 0,
      deltaFiles: (live.byDirectory.get(path)?.files ?? 0) - (branch.byDirectory.get(path)?.files ?? 0),
    })).filter(item => item.deltaFiles !== 0)
      .sort((a, b) => Math.abs(b.deltaFiles) - Math.abs(a.deltaFiles))
      .slice(0, 35);

    branches.push({
      name: names[index],
      rootPath: branch.rootPath,
      indexed: branch.counts,
      live: live.counts,
      deltaFiles: live.counts.files - branch.counts.files,
      deltaBytes: live.counts.logicalBytes - branch.counts.logicalBytes,
      topDifferences: diffs,
      links: live.links,
      problems: live.problems,
    });
  }

  const report: AuditReport = {
    schema: 'ansyswarden.tree-audit.v1',
    generatedAt: new Date().toISOString(),
    sourceScanId: metadata.id,
    sourceScanAt: metadata.createdAt,
    sourceIndex: metadata.indexPath,
    scopeRoot: rootPath,
    methodology: 'Comparación de entradas lstat del índice anterior con nuevo recorrido lstat. No sigue directorios enlazados ni puntos de unión.',
    branches,
    totals: {
      indexedFiles: branches.reduce((n, branch) => n + branch.indexed.files, 0),
      liveFiles: branches.reduce((n, branch) => n + branch.live.files, 0),
      deltaFiles: branches.reduce((n, branch) => n + branch.deltaFiles, 0),
    },
    limitations: [
      'TreeSize no se consulta directamente: compare sus cifras manualmente con liveFiles.',
      'El índice y la auditoría son capturas de momentos distintos; una diferencia no prueba omisión.',
      'Los enlaces a directorios se señalan como candidatos a junction; lstat no identifica de forma fiable todos los tipos de reparse point.',
      'Los enlaces y junctions no se recorren para evitar ciclos o doble contabilización.',
      'El tamaño usado es lógico (stats.size), no espacio físico asignado.',
      'Las ramas elegidas se buscan por nombre exacto y se elige la coincidencia menos profunda.',
    ],
  };

  const outputPath = resolve(options.outputPath ?? join(process.cwd(), '.ansyswarden', 'tree', 'audits', 'tree-audit-' + Date.now() + '.json'));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return { report, outputPath };
}
