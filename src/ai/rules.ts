import type { ClassificationResult } from './types';

type Rule = { pattern: RegExp; reason: string };

// Estas son zonas donde puede existir información única del usuario. Tienen
// prioridad absoluta sobre cualquier indicio de caché que aparezca más abajo.
const USER_DATA_PATTERNS: Rule[] = [
  { pattern: /(^|\/)(documents|documentos)(\/|$)/i, reason: 'Ruta asociada a documentos del usuario.' },
  { pattern: /(^|\/)(pictures|photos|fotos|dcim)(\/|$)/i, reason: 'Ruta asociada a fotografías o imágenes del usuario.' },
  { pattern: /(^|\/)(movies|videos|vídeos)(\/|$)/i, reason: 'Ruta asociada a vídeos del usuario.' },
  { pattern: /(^|\/)(music|música)(\/|$)/i, reason: 'Ruta asociada a contenido multimedia del usuario.' },
  { pattern: /(^|\/)(download|downloads|descargas)(\/|$)/i, reason: 'La carpeta de descargas puede contener datos personales o únicos.' },
  { pattern: /(^|\/)(backup|backups|copia|copias|respaldo|respaldos)(\/|$)/i, reason: 'Las copias de seguridad pueden contener la única copia recuperable de datos.' },
  { pattern: /(^|\/)(save|saves|savegame|savegames|partidas)(\/|$)/i, reason: 'Ruta asociada a partidas o estados guardados del usuario.' },
  { pattern: /(^|\/)(projects|proyectos)(\/|$)/i, reason: 'Ruta asociada a proyectos del usuario.' },
  { pattern: /(^|\/)(config|configs|configuration|settings|preferences|profiles|perfiles)(\/|$)/i, reason: 'Configuración o perfiles que no deben considerarse caché por defecto.' },
  { pattern: /(^|\/)(mods|screenshots|capturas)(\/|$)/i, reason: 'Contenido creado, instalado o conservado explícitamente por el usuario.' },
];

// Solo reglas suficientemente específicas pueden conceder SAFE_CACHE. Evitamos
// reglas globales como /build, /dist o /.cache: por sí solas no demuestran que
// el contenido sea regenerable y seguro de eliminar.
const SAFE_CACHE_PATTERNS: Rule[] = [
  { pattern: /(^|\/)\.gradle\/caches(\/|$)/i, reason: 'Caché de Gradle conocida y regenerable.' },
  { pattern: /(^|\/)\.gradle\/daemon(\/|$)/i, reason: 'Estado temporal conocido del daemon de Gradle.' },
  { pattern: /(^|\/)node_modules(\/|$)/i, reason: 'Dependencias de Node.js regenerables mediante el gestor de paquetes.' },
];

export function classifyByRules(inputPath: string): ClassificationResult | null {
  const normalized = inputPath.replace(/\\/g, '/');

  // Regla de oro: una zona protegida siempre gana, incluso si dentro aparecen
  // nombres como node_modules, cache, build o dist.
  for (const rule of USER_DATA_PATTERNS) {
    if (rule.pattern.test(normalized)) {
      return {
        path: inputPath,
        classification: 'USER_DATA',
        confidence: 1,
        reason: rule.reason,
        source: 'rule',
      };
    }
  }

  for (const rule of SAFE_CACHE_PATTERNS) {
    if (rule.pattern.test(normalized)) {
      return {
        path: inputPath,
        classification: 'SAFE_CACHE',
        confidence: 0.99,
        reason: rule.reason,
        source: 'rule',
      };
    }
  }

  return null;
}
