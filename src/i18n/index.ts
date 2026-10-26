export type SupportedLanguage = 'en' | 'es';

type TranslationValue = string;
type TranslationCatalog = Record<string, TranslationValue>;

const CATALOGS: Record<SupportedLanguage, TranslationCatalog> = {
  en: {
    'common.usage': 'Usage:',
    'common.path': 'Path',
    'common.name': 'Name',
    'common.size': 'Size',
    'common.files': 'Files',
    'common.directories': 'Directories',
    'common.skipped': 'Skipped',
    'common.oldest': 'Oldest',
    'common.newest': 'Newest',
    'common.trace': 'Trace',
    'common.source': 'Source',
    'common.classification': 'Classification',
    'common.file': 'File',
    'backend.token_missing': 'ANSYSWARDEN_API_TOKEN is missing or too short. Generate one with: ./ansys backend token',
    'backend.invalid_port': 'Invalid port: {port}',
    'inspect.title': 'AnSysWarden · Artifact Inspect',
    'inspect.usage': 'Usage: inspect-cli <path>',
    'inspect.file_types': 'DOMINANT FILE TYPES',
    'inspect.no_files': '(no files detected)',
    'inspect.plain_english': 'IN PLAIN ENGLISH',
    'inspect.description': '🧭 This describes what is actually inside the folder.',
    'inspect.gemma_pending': '🤖 Gemma has not been asked yet whether it is cache or not.',
    'inspect.no_changes': '🛡️ No file has been deleted or modified.',
    'inspect.failed': '[AnSysWarden] Inspection failed:',
  },
  es: {
    'common.usage': 'Uso:',
    'common.path': 'Ruta',
    'common.name': 'Nombre',
    'common.size': 'Tamaño',
    'common.files': 'Archivos',
    'common.directories': 'Directorios',
    'common.skipped': 'Omitidos',
    'common.oldest': 'Más antiguo',
    'common.newest': 'Más reciente',
    'common.trace': 'Traza',
    'common.source': 'Fuente',
    'common.classification': 'Clasificación',
    'common.file': 'Archivo',
    'backend.token_missing': 'Falta ANSYSWARDEN_API_TOKEN o es demasiado corto. Genera uno con: ./ansys backend token',
    'backend.invalid_port': 'Puerto inválido: {port}',
    'inspect.title': 'AnSysWarden · Inspección de artefacto',
    'inspect.usage': 'Uso: inspect-cli <ruta>',
    'inspect.file_types': 'TIPOS DE ARCHIVO DOMINANTES',
    'inspect.no_files': '(sin archivos detectados)',
    'inspect.plain_english': 'EN HUMANO',
    'inspect.description': '🧭 Esto describe qué hay realmente dentro de la carpeta.',
    'inspect.gemma_pending': '🤖 Todavía no se ha preguntado a Gemma si es caché o no.',
    'inspect.no_changes': '🛡️ No se ha borrado ni modificado ningún archivo.',
    'inspect.failed': '[AnSysWarden] Error al inspeccionar:',
  },
};

let activeLanguage: SupportedLanguage | null = null;

export function normalizeLanguage(value: string | undefined): SupportedLanguage | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'en' || normalized.startsWith('en-') || normalized.startsWith('en_')) return 'en';
  if (normalized === 'es' || normalized.startsWith('es-') || normalized.startsWith('es_')) return 'es';
  return null;
}

export function resolveLanguage(args: string[] = process.argv.slice(2)): SupportedLanguage {
  const langIndex = args.indexOf('--lang');
  const fromCli = langIndex >= 0 ? normalizeLanguage(args[langIndex + 1]) : null;
  if (fromCli) return fromCli;

  const fromEnv = normalizeLanguage(process.env.ANSYSWARDEN_LANG);
  if (fromEnv) return fromEnv;

  return 'en';
}

export function setLanguage(language: SupportedLanguage): void {
  activeLanguage = language;
}

export function getLanguage(): SupportedLanguage {
  return activeLanguage ?? resolveLanguage();
}

export function t(key: string, params: Record<string, string | number> = {}): string {
  const language = getLanguage();
  const template = CATALOGS[language][key] ?? CATALOGS.en[key] ?? key;

  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
    const value = params[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}
