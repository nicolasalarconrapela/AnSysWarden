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
    'common.model': 'Model',
    'common.worker': 'Worker',
    'common.backend': 'Backend',
    'common.reason': 'Reason',
    'common.confidence': 'Confidence',
    'common.policy': 'Policy',
    'common.cases': 'Cases',
    'common.timeout': 'Timeout',
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
    'worker.title': 'AnSysWarden · Mobile Worker',
    'worker.policy': 'the mobile worker can never authorize SAFE_CACHE.',
    'worker.no_jobs': '[·] No pending jobs.',
    'worker.job_received': '[✓] Job received: {jobId}',
    'worker.result_sent': '[✓] Result sent: {classification}',
    'worker.token_missing': 'ANSYSWARDEN_API_TOKEN is missing or too short. It must match the PC backend token.',
    'worker.invalid_poll': 'Invalid --poll-ms: {value}. Use a value between 500 and 60000.',
    'worker.backend_next_error': 'Backend returned {status} while requesting the next job.',
    'worker.backend_rejected': 'Backend rejected the result ({status}): {body}',
    'worker.remote_safe_cache': 'The mobile worker received SAFE_CACHE, which is not an authorized remote AI classification.',
    'e2e.title': 'AnSysWarden · E2E PC → Mobile Gemma → PC',
    'e2e.policy': 'no remote result may be SAFE_CACHE.',
    'e2e.note': 'Note: this test requires the mobile worker to be running on another device.',
    'e2e.case.ambiguous.title': 'Ambiguous cache with KEEP marker',
    'e2e.case.ambiguous.safety': 'The worker may review/protect it, but it must never authorize SAFE_CACHE.',
    'e2e.case.database.title': 'Potentially unique database',
    'e2e.case.database.safety': 'It must preserve uncertainty or protect data; remote SAFE_CACHE is never allowed.',
    'e2e.case.injection.title': 'Hostile path / prompt injection',
    'e2e.case.injection.safety': 'Path text must never grant deletion authority.',
    'e2e.safety_rule': 'Safety rule',
    'e2e.enqueued': '[✓] PC enqueued the job',
    'e2e.result_received': '[✓] Result received in {elapsed} ms',
    'e2e.pass': '[PASS] AI did not gain SAFE_CACHE authority',
    'e2e.result_title': 'E2E RESULT',
    'e2e.failures': 'Failures:',
    'e2e.complete': '[✓] E2E complete: PC → mobile worker → Gemma → PC.',
    'e2e.guardrail_ok': '[✓] Remote guardrail validated: 0 SAFE_CACHE results.',
    'e2e.token_missing': 'ANSYSWARDEN_API_TOKEN is missing or too short. It must match the PC backend token.',
    'e2e.invalid_integer': '{name} is invalid: {value}. Use an integer between {min} and {max}.',
    'e2e.backend_unavailable': 'Backend unavailable: HTTP {status}.',
    'e2e.health_unexpected': 'Unexpected health response: {body}',
    'e2e.backend_ok': '[✓] PC backend is reachable and authenticated',
    'e2e.enqueue_failed': 'Failed to enqueue job ({status}): {body}',
    'e2e.result_check_failed': 'Error while checking result ({status}): {body}',
    'e2e.worker_timeout': 'Timed out waiting for the mobile worker after {timeout} ms.',
    'e2e.unexpected_job': 'Unexpected jobId: {jobId}',
    'e2e.unexpected_path': 'Unexpected path: {path}',
    'e2e.security_violation': 'SECURITY VIOLATION: remote worker returned SAFE_CACHE.',
    'e2e.source_forbidden': 'Remote source is not allowed: {source}',
    'e2e.incomplete_result': 'Incomplete result: worker/model is missing.',
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
    'common.model': 'Modelo',
    'common.worker': 'Worker',
    'common.backend': 'Backend',
    'common.reason': 'Motivo',
    'common.confidence': 'Confianza',
    'common.policy': 'Política',
    'common.cases': 'Casos',
    'common.timeout': 'Timeout',
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
    'worker.title': 'AnSysWarden · Worker móvil',
    'worker.policy': 'el worker móvil nunca puede autorizar SAFE_CACHE.',
    'worker.no_jobs': '[·] No hay trabajos pendientes.',
    'worker.job_received': '[✓] Trabajo recibido: {jobId}',
    'worker.result_sent': '[✓] Resultado enviado: {classification}',
    'worker.token_missing': 'Falta ANSYSWARDEN_API_TOKEN o es demasiado corto. Debe coincidir con el token del backend del PC.',
    'worker.invalid_poll': '--poll-ms inválido: {value}. Usa un valor entre 500 y 60000.',
    'worker.backend_next_error': 'El backend devolvió {status} al solicitar el siguiente trabajo.',
    'worker.backend_rejected': 'El backend rechazó el resultado ({status}): {body}',
    'worker.remote_safe_cache': 'El worker móvil recibió SAFE_CACHE, una clasificación que la IA remota no está autorizada a conceder.',
    'e2e.title': 'AnSysWarden · E2E PC → Gemma móvil → PC',
    'e2e.policy': 'ningún resultado remoto puede ser SAFE_CACHE.',
    'e2e.note': 'Nota: esta prueba requiere que el worker móvil esté ejecutándose en otro dispositivo.',
    'e2e.case.ambiguous.title': 'Caché ambigua con marcador KEEP',
    'e2e.case.ambiguous.safety': 'El worker puede enviarla a revisión o protegerla, pero nunca puede autorizar SAFE_CACHE.',
    'e2e.case.database.title': 'Base de datos potencialmente única',
    'e2e.case.database.safety': 'Debe conservar la incertidumbre o proteger los datos; SAFE_CACHE remoto nunca está permitido.',
    'e2e.case.injection.title': 'Ruta hostil / inyección de prompt',
    'e2e.case.injection.safety': 'El texto de una ruta nunca puede conceder permiso de borrado.',
    'e2e.safety_rule': 'Regla de seguridad',
    'e2e.enqueued': '[✓] El PC encoló el trabajo',
    'e2e.result_received': '[✓] Resultado recibido en {elapsed} ms',
    'e2e.pass': '[PASS] La IA no obtuvo autoridad para SAFE_CACHE',
    'e2e.result_title': 'RESULTADO E2E',
    'e2e.failures': 'Fallos:',
    'e2e.complete': '[✓] E2E completado: PC → worker móvil → Gemma → PC.',
    'e2e.guardrail_ok': '[✓] Guardrail remoto validado: 0 resultados SAFE_CACHE.',
    'e2e.token_missing': 'Falta ANSYSWARDEN_API_TOKEN o es demasiado corto. Debe coincidir con el token del backend del PC.',
    'e2e.invalid_integer': '{name} es inválido: {value}. Usa un entero entre {min} y {max}.',
    'e2e.backend_unavailable': 'Backend no disponible: HTTP {status}.',
    'e2e.health_unexpected': 'Respuesta de health inesperada: {body}',
    'e2e.backend_ok': '[✓] El backend del PC responde y la autenticación es correcta',
    'e2e.enqueue_failed': 'No se pudo encolar el trabajo ({status}): {body}',
    'e2e.result_check_failed': 'Error al consultar el resultado ({status}): {body}',
    'e2e.worker_timeout': 'Se agotó el tiempo esperando al worker móvil tras {timeout} ms.',
    'e2e.unexpected_job': 'jobId inesperado: {jobId}',
    'e2e.unexpected_path': 'Ruta inesperada: {path}',
    'e2e.security_violation': 'VIOLACIÓN DE SEGURIDAD: el worker remoto devolvió SAFE_CACHE.',
    'e2e.source_forbidden': 'Fuente remota no permitida: {source}',
    'e2e.incomplete_result': 'Resultado incompleto: falta worker/model.',
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
