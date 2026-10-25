import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function getDustToolsRoot(): string {
  return resolve(process.env.ANSYSWARDEN_TOOLS_DIR ?? '.ansyswarden/tools');
}

export function getManagedDustDir(): string {
  return join(getDustToolsRoot(), 'dust');
}

export function getManagedDustBin(): string {
  return process.platform === 'win32'
    ? join(getManagedDustDir(), 'bin', 'dust.exe')
    : join(getManagedDustDir(), 'bin', 'dust');
}

export function resolveDustBin(): { path: string; source: 'env' | 'managed' | 'path' } {
  const configured = process.env.ANSYSWARDEN_DUST_BIN?.trim();
  if (configured) return { path: configured, source: 'env' };

  const managed = getManagedDustBin();
  if (existsSync(managed)) return { path: managed, source: 'managed' };

  return { path: 'dust', source: 'path' };
}
