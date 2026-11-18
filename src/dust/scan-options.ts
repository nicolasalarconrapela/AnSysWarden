import type { DustScanOptions } from './dust-scanner';

export type DustCaptureMode = 'inventory' | 'legacy';

export interface DustCaptureArguments {
  rootPath: string;
  mode: DustCaptureMode;
  htmlPath: string | null;
  outputPath?: string;
  days: number;
  allocated: boolean;
  strict: boolean;
  legacy: DustScanOptions;
}

/**
 * Analizador único de argumentos para la captura desde Dust.
 * No efectúa I/O y falla ante opciones desconocidas o incompatibles.
 *
 * - scan e inventory: inventario completo por defecto.
 * - scan --legacy: formato antiguo (Dust resumido + ai-input).
 * - Opciones antiguas --depth/--min-size/...: activan compatibilidad.
 */
export function parseDustCaptureArguments(
  command: 'scan' | 'inventory',
  args: readonly string[],
): DustCaptureArguments {
  const positional: string[] = [];
  const seen = new Set<string>();
  const legacy: DustScanOptions = {};
  let htmlPath: string | null = null;
  let outputPath: string | undefined;
  let days = 180;
  let allocated = true;
  let strict = false;
  let legacyRequested = false;
  let legacyOnlyOptions = false;
  let inventoryOnlyOptions = false;

  const one = (name: string): void => {
    if (seen.has(name)) throw new Error('Opción duplicada: ' + name);
    seen.add(name);
  };

  const valueAt = (index: number, flag: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Falta el valor de ' + flag);
    return value;
  };

  const positiveInteger = (value: string, flag: string, limit: number): number => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > limit) {
      throw new Error('Valor inválido para ' + flag + ': ' + value + ' (1..' + limit + ')');
    }
    return number;
  };

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag.startsWith('--')) {
      positional.push(flag);
      continue;
    }
    if (flag === '--legacy') {
      one(flag);
      legacyRequested = true;
      continue;
    }
    if (flag === '--full') {
      one(flag);
      legacy.full = true;
      legacyOnlyOptions = true;
      continue;
    }
    if (flag === '--no-allocated') {
      one(flag);
      allocated = false;
      inventoryOnlyOptions = true;
      continue;
    }
    if (flag === '--strict') {
      one(flag);
      strict = true;
      inventoryOnlyOptions = true;
      continue;
    }
    if (flag === '--html') {
      one(flag);
      const next = args[i + 1];
      htmlPath = next && !next.startsWith('--') ? next : '';
      if (htmlPath !== '') i++;
      continue;
    }
    if (flag === '--output' || flag === '--out') {
      one('--output');
      outputPath = valueAt(i, flag);
      i++;
      inventoryOnlyOptions = true;
      continue;
    }
    if (flag === '--days') {
      one(flag);
      days = positiveInteger(valueAt(i, flag), flag, 36500);
      i++;
      inventoryOnlyOptions = true;
      continue;
    }
    if (flag === '--depth' || flag === '--ai-depth' || flag === '--ai-max-entries') {
      one(flag);
      const amount = positiveInteger(valueAt(i, flag), flag, flag === '--depth' ? 32 : 1000000);
      if (flag === '--depth') legacy.depth = amount;
      else if (flag === '--ai-depth') legacy.aiTreeDepth = amount;
      else legacy.aiTreeMaxEntries = amount;
      i++;
      legacyOnlyOptions = true;
      continue;
    }
    if (flag === '--min-size') {
      one(flag);
      const value = valueAt(i, flag);
      if (!/^[0-9]+(?:\.[0-9]+)?(?:B|K|KB|KIB|M|MB|MIB|G|GB|GIB|T|TB|TIB)?$/i.test(value)) {
        throw new Error('Valor inválido para --min-size: ' + value);
      }
      legacy.minSize = value;
      legacyOnlyOptions = true;
      i++;
      continue;
    }
    throw new Error('Opción desconocida: ' + flag);
  }

  if (positional.length !== 1 || !positional[0].trim()) {
    throw new Error('Se necesita exactamente una carpeta raíz.');
  }
  const mode = legacyRequested || legacyOnlyOptions ? 'legacy' : 'inventory';
  if (command === 'inventory' && mode === 'legacy') {
    throw new Error('dust inventory no acepta opciones del modo antiguo.');
  }
  if (mode === 'legacy' && inventoryOnlyOptions) {
    throw new Error('No se pueden mezclar opciones del inventario con las del modo --legacy.');
  }

  return {
    rootPath: positional[0],
    mode,
    htmlPath,
    ...(outputPath === undefined ? {} : { outputPath }),
    days,
    allocated,
    strict,
    legacy,
  };
}
