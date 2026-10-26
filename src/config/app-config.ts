import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const APP_CONFIG_SCHEMA = 'ansyswarden.config.v1' as const;
export type ConfigLanguage = 'en' | 'es';

export interface AppConfig {
  schema: typeof APP_CONFIG_SCHEMA;
  language?: ConfigLanguage;
  [key: string]: unknown;
}

export function getConfigPath(): string {
  const configured = process.env.ANSYSWARDEN_CONFIG_FILE?.trim();
  if (configured) return resolve(configured);
  return join(homedir(), '.ansyswarden', 'config.json');
}

export function normalizeConfigLanguage(value: unknown): ConfigLanguage | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'en') return 'en';
  if (normalized === 'es') return 'es';
  return null;
}

export function readAppConfig(): AppConfig {
  const path = getConfigPath();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { schema: APP_CONFIG_SCHEMA };
    }

    const object = parsed as Record<string, unknown>;
    const language = normalizeConfigLanguage(object.language);
    return {
      ...object,
      schema: APP_CONFIG_SCHEMA,
      ...(language ? { language } : {}),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { schema: APP_CONFIG_SCHEMA };
    if (error instanceof SyntaxError) return { schema: APP_CONFIG_SCHEMA };
    throw error;
  }
}

export function readConfiguredLanguage(): ConfigLanguage | null {
  return readAppConfig().language ?? null;
}

export function writeConfiguredLanguage(language: ConfigLanguage): AppConfig {
  const path = getConfigPath();
  const config: AppConfig = {
    ...readAppConfig(),
    schema: APP_CONFIG_SCHEMA,
    language,
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config;
}
