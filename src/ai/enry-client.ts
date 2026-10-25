import { spawn } from 'node:child_process';

export interface EnryDetection {
  available: boolean;
  languages: string[];
  reason?: string;
}

export async function detectLanguagesWithEnry(root: string): Promise<EnryDetection> {
  const bin = process.env.ANSYSWARDEN_ENRY_BIN ?? 'enry';
  try {
    const result = await run(bin, ['--json', root]);
    const parsed = JSON.parse(result) as unknown;
    const languages = extractLanguageNames(parsed);
    return { available: true, languages };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { available: false, languages: [], reason: 'Enry no está instalado; se usa detección local por manifests.' };
    }
    return {
      available: false,
      languages: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractLanguageNames(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return [];
  const object = value as Record<string, unknown>;

  const names = new Set<string>();
  for (const [key, child] of Object.entries(object)) {
    if (typeof child === 'number') names.add(key);
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const nested = child as Record<string, unknown>;
      for (const nestedKey of Object.keys(nested)) names.add(nestedKey);
    }
  }
  return [...names].filter(Boolean).sort();
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Enry terminó con código ${String(code)}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}
