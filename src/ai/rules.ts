import type { ClassificationResult } from './types';

const SAFE_CACHE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\/)node_modules(\/|$)/i, reason: 'Dependencias de Node.js regenerables mediante el gestor de paquetes.' },
  { pattern: /(^|\/)\.gradle\/caches(\/|$)/i, reason: 'Caché de Gradle regenerable.' },
  { pattern: /(^|\/)\.gradle\/daemon(\/|$)/i, reason: 'Estado temporal del daemon de Gradle.' },
  { pattern: /(^|\/)build(\/|$)/i, reason: 'Directorio de salida de compilación normalmente regenerable.' },
  { pattern: /(^|\/)dist(\/|$)/i, reason: 'Directorio de distribución generado por herramientas de build.' },
  { pattern: /(^|\/)\.cache(\/|$)/i, reason: 'Directorio identificado explícitamente como caché.' },
];

const USER_DATA_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\/)(documents|documentos)(\/|$)/i, reason: 'Ruta asociada a documentos del usuario.' },
  { pattern: /(^|\/)(pictures|photos|fotos|dcim)(\/|$)/i, reason: 'Ruta asociada a fotografías o imágenes del usuario.' },
  { pattern: /(^|\/)(movies|videos|vídeos)(\/|$)/i, reason: 'Ruta asociada a vídeos del usuario.' },
  { pattern: /(^|\/)(music|música)(\/|$)/i, reason: 'Ruta asociada a contenido multimedia del usuario.' },
  { pattern: /(^|\/)(download|downloads|descargas)(\/|$)/i, reason: 'La carpeta de descargas puede contener datos personales o únicos.' },
];

export function classifyByRules(inputPath: string): ClassificationResult | null {
  const normalized = inputPath.replace(/\\/g, '/');

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
