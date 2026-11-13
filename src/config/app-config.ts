import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const APP_CONFIG_SCHEMA = 'ansyswarden.config.v1' as const;
export type ConfigLanguage = 'en' | 'es';

export interface AppConfig {
  schema: typeof APP_CONFIG_SCHEMA;
  language?: ConfigLanguage;
  backendUrl?: string;
  apiToken?: string;
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

function normalizeBackendUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(normalized) ? normalized : undefined;
}

function normalizeApiToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length >= 24 ? normalized : undefined;
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
    const backendUrl = normalizeBackendUrl(object.backendUrl);
    const apiToken = normalizeApiToken(object.apiToken);
    const {
      language: _discardedLanguage,
      backendUrl: _discardedBackendUrl,
      apiToken: _discardedApiToken,
      schema: _discardedSchema,
      ...rest
    } = object;

    return {
      ...rest,
      schema: APP_CONFIG_SCHEMA,
      ...(language ? { language } : {}),
      ...(backendUrl ? { backendUrl } : {}),
      ...(apiToken ? { apiToken } : {}),
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

function writeAppConfig(config: AppConfig): AppConfig {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config;
}

export function writeConfiguredLanguage(language: ConfigLanguage): AppConfig {
  return writeAppConfig({
    ...readAppConfig(),
    schema: APP_CONFIG_SCHEMA,
    language,
  });
}

export function writeBackendUrl(backendUrl: string): AppConfig {
  const normalized = normalizeBackendUrl(backendUrl);
  if (!normalized) throw new Error(`Invalid backend URL: ${backendUrl}`);
  return writeAppConfig({
    ...readAppConfig(),
    schema: APP_CONFIG_SCHEMA,
    backendUrl: normalized,
  });
}

export function writeApiToken(apiToken: string): AppConfig {
  const normalized = normalizeApiToken(apiToken);
  if (!normalized) throw new Error('API token must contain at least 24 characters.');
  return writeAppConfig({
    ...readAppConfig(),
    schema: APP_CONFIG_SCHEMA,
    apiToken: normalized,
  });
}
