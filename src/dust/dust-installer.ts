import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { getManagedDustBin, getManagedDustDir } from './dust-path';

const RELEASE_API = 'https://api.github.com/repos/bootandy/dust/releases/latest';
const USER_AGENT = 'AnSysWarden/0.1';

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

export interface DustInstallResult {
  version: string;
  architecture: string;
  asset: string;
  binPath: string;
  sha256: string;
}

export async function installDust(): Promise<DustInstallResult> {
  if (process.platform !== 'win32') {
    throw new Error('La instalación gestionada de Dust está implementada por ahora para Windows.');
  }

  const architecture = windowsArchitecture(process.arch);
  const release = await fetchJson<GitHubRelease>(RELEASE_API);
  const version = release.tag_name.replace(/^v/, '');
  const expectedAsset = `dust-v${version}-${architecture}-pc-windows-msvc.zip`;
  const asset = release.assets.find((item) => item.name === expectedAsset);
  if (!asset) {
    throw new Error(`La release ${release.tag_name} no contiene ${expectedAsset}.`);
  }

  const expectedSha256 = parseSha256Digest(asset.digest);
  if (!expectedSha256) {
    throw new Error(`GitHub no publicó un digest SHA-256 verificable para ${asset.name}.`);
  }

  const installDir = getManagedDustDir();
  const binDir = join(installDir, 'bin');
  const tempDir = join(installDir, `.install-${process.pid}-${Date.now()}`);
  const archive = join(tempDir, asset.name);
  const extractDir = join(tempDir, 'extract');

  await mkdir(tempDir, { recursive: true });
  try {
    await downloadFile(asset.browser_download_url, archive);
    const actualSha256 = await sha256File(archive);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `SHA-256 de Dust no coincide. Esperado ${expectedSha256}, recibido ${actualSha256}. Instalación cancelada.`,
      );
    }

    await mkdir(extractDir, { recursive: true });
    await expandZipWindows(archive, extractDir);

    const extracted = await findDustExe(extractDir);
    if (!extracted) throw new Error('El ZIP oficial de Dust no contiene dust.exe.');

    await mkdir(binDir, { recursive: true });
    const destination = getManagedDustBin();
    await rm(destination, { force: true });
    await rename(extracted, destination);

    const info = await stat(destination);
    if (!info.isFile() || info.size <= 0) throw new Error('dust.exe quedó instalado de forma inválida.');

    return {
      version,
      architecture,
      asset: asset.name,
      binPath: destination,
      sha256: actualSha256,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function windowsArchitecture(arch: NodeJS.Architecture): 'x86_64' | 'aarch64' {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';
  throw new Error(`Arquitectura Windows no soportada para Dust: ${arch}`);
}

function parseSha256Digest(digest: string | null | undefined): string | null {
  if (!digest) return null;
  const match = digest.match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub respondió HTTP ${response.status} al consultar Dust.`);
  return await response.json() as T;
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`No se pudo descargar Dust: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(join(destination, '..'), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(destination, bytes, { flag: 'wx' });
}

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

async function expandZipWindows(archive: string, destination: string): Promise<void> {
  const escapedArchive = psQuote(archive);
  const escapedDestination = psQuote(destination);
  const command = `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
}

async function findDustExe(root: string): Promise<string | null> {
  const { readdir } = await import('node:fs/promises');
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && entry.name.toLowerCase() === 'dust.exe') return full;
    }
  }
  return null;
}

function psQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolvePromise();
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(`No se pudo extraer Dust${detail ? `: ${detail}` : ''}`));
    });
  });
}
