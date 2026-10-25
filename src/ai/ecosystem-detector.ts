import { opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type Ecosystem = 'node' | 'rust' | 'python' | 'gradle' | 'go' | 'dotnet' | 'php' | 'ruby' | 'unknown';

export interface EcosystemDetection {
  ecosystem: Ecosystem;
  confidence: number;
  markers: string[];
}

const MARKERS: Array<{ ecosystem: Ecosystem; file: RegExp; weight: number }> = [
  { ecosystem: 'node', file: /^package\.json$/i, weight: 5 },
  { ecosystem: 'node', file: /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i, weight: 3 },
  { ecosystem: 'rust', file: /^Cargo\.toml$/i, weight: 6 },
  { ecosystem: 'rust', file: /^Cargo\.lock$/i, weight: 3 },
  { ecosystem: 'python', file: /^(pyproject\.toml|requirements(?:-[^.]+)?\.txt|Pipfile)$/i, weight: 5 },
  { ecosystem: 'python', file: /^(uv\.lock|poetry\.lock|Pipfile\.lock)$/i, weight: 3 },
  { ecosystem: 'gradle', file: /^(build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradlew(?:\.bat)?)$/i, weight: 5 },
  { ecosystem: 'go', file: /^go\.mod$/i, weight: 6 },
  { ecosystem: 'go', file: /^go\.sum$/i, weight: 3 },
  { ecosystem: 'dotnet', file: /\.(?:sln|csproj|fsproj|vbproj)$/i, weight: 5 },
  { ecosystem: 'php', file: /^composer\.json$/i, weight: 6 },
  { ecosystem: 'php', file: /^composer\.lock$/i, weight: 3 },
  { ecosystem: 'ruby', file: /^Gemfile$/i, weight: 6 },
  { ecosystem: 'ruby', file: /^Gemfile\.lock$/i, weight: 3 },
];

export async function detectEcosystems(directory: string): Promise<EcosystemDetection[]> {
  let handle;
  try {
    handle = await opendir(directory);
  } catch {
    return [];
  }

  const scores = new Map<Ecosystem, { score: number; markers: string[] }>();
  for await (const entry of handle) {
    if (!entry.isFile()) continue;
    for (const marker of MARKERS) {
      if (!marker.file.test(entry.name)) continue;
      const current = scores.get(marker.ecosystem) ?? { score: 0, markers: [] };
      current.score += marker.weight;
      current.markers.push(entry.name);
      scores.set(marker.ecosystem, current);
    }
  }

  return [...scores.entries()]
    .filter(([, value]) => value.score >= 5)
    .map(([ecosystem, value]) => ({
      ecosystem,
      confidence: Math.min(0.99, 0.55 + value.score * 0.05),
      markers: [...new Set(value.markers)].sort(),
    }))
    .sort((a, b) => b.confidence - a.confidence || a.ecosystem.localeCompare(b.ecosystem));
}

export function decideByEcosystem(fullPath: string, isDirectory: boolean, ecosystems: EcosystemDetection[]): { kind: 'BUILD_OUTPUT' | 'NODE_DEPENDENCIES' | 'PYTHON_ENV' | 'VENDORED'; reason: string } | null {
  if (!isDirectory) return null;
  const name = basename(fullPath).toLowerCase();
  const detected = new Set(ecosystems.map((item) => item.ecosystem));

  if (detected.has('rust') && name === 'target') {
    return { kind: 'BUILD_OUTPUT', reason: 'Directorio target reconocido dentro de un proyecto Rust por sus manifests.' };
  }
  if (detected.has('node') && name === 'node_modules') {
    return { kind: 'NODE_DEPENDENCIES', reason: 'node_modules reconocido dentro de un proyecto Node.js por package.json/lockfiles.' };
  }
  if (detected.has('node') && ['dist', '.next', '.nuxt', 'out'].includes(name)) {
    return { kind: 'BUILD_OUTPUT', reason: 'Salida generada reconocida dentro de un proyecto Node.js.' };
  }
  if (detected.has('python') && ['.venv', 'venv'].includes(name)) {
    return { kind: 'PYTHON_ENV', reason: 'Entorno virtual reconocido dentro de un proyecto Python.' };
  }
  if (detected.has('gradle') && ['.gradle', 'build'].includes(name)) {
    return { kind: 'BUILD_OUTPUT', reason: 'Salida/estado de build reconocido dentro de un proyecto Gradle.' };
  }
  if (detected.has('go') && name === 'vendor') {
    return { kind: 'VENDORED', reason: 'Dependencias vendorizadas reconocidas dentro de un proyecto Go.' };
  }
  if (detected.has('php') && name === 'vendor') {
    return { kind: 'VENDORED', reason: 'Dependencias vendorizadas reconocidas dentro de un proyecto PHP/Composer.' };
  }

  return null;
}

export async function detectNearestEcosystems(root: string, directory: string): Promise<EcosystemDetection[]> {
  const direct = await detectEcosystems(directory);
  if (direct.length > 0) return direct;
  if (directory === root) return [];
  return [];
}

export async function collectEcosystemLabels(root: string): Promise<string[]> {
  const labels = new Set<string>();
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    for (const detection of await detectEcosystems(directory)) labels.add(detection.ecosystem);
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      return;
    }
    for await (const entry of handle) {
      if (!entry.isDirectory()) continue;
      if (/^(node_modules|\.git|\.venv|venv|target|dist|build)$/i.test(entry.name)) continue;
      await walk(join(directory, entry.name), depth + 1);
    }
  };
  await walk(root, 0);
  return [...labels].sort();
}
