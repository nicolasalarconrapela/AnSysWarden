import { networkInterfaces } from 'node:os';
import { readAppConfig } from '../../config/app-config';
import { isScanDocument, type ScanDocument, type ScanOrigin } from '../../core/contracts/backend-protocol';
import { BackendStorage } from '../../infrastructure/persistence/backend-storage';
import { ScanCache, type CachedScanMetadata } from '../../infrastructure/persistence/scan-cache';

interface ScanSummary {
  id: string;
  createdAt: string;
  source: string;
  computer: string;
  entries: number;
  origin?: ScanOrigin;
}

type ListScope = 'all' | 'here' | 'connected';
type HereKind = 'original' | 'copy' | 'original+copy';

interface HereScanSummary extends ScanSummary {
  kind: HereKind;
  cachedAt?: string;
}

interface ListOptions {
  scope: ListScope;
  idsOnly: boolean;
  max: number;
}

const DEFAULT_LIST_MAX = 10;
const MAX_LIST_MAX = 1000;

function usage(exitCode = 0): never {
  console.log('AnSysWarden · Escaneos');
  console.log('────────────────────────────────────────');
  console.log('El significado es idéntico en PC y móvil:');
  console.log('  here       este dispositivo');
  console.log('  connected  el dispositivo configurado/conectado');
  console.log('');
  console.log('Listados:');
  console.log('  ./ansys-scans list                         Últimos 10 de ambos lados');
  console.log('  ./ansys-scans list here                    Solo este dispositivo');
  console.log('  ./ansys-scans list connected               Solo dispositivo conectado');
  console.log('  ./ansys-scans list --ids                   Solo IDs');
  console.log('  ./ansys-scans list --max 25                Máximo 25 por grupo');
  console.log('  ./ansys-scans list connected --ids --max 5 Combina filtros');
  console.log('');
  console.log('Transferencia y consulta:');
  console.log('  ./ansys-scans pull latest                  Copia aquí el último del conectado');
  console.log('  ./ansys-scans pull <id>                    Copia aquí un escaneo concreto');
  console.log('  ./ansys-scans show <id>                    Muestra un escaneo disponible aquí');
  console.log('');
  console.log('Limpieza:');
  console.log('  ./ansys-scans delete here <id>             Borra de este dispositivo');
  console.log('  ./ansys-scans delete here --all            Borra todos los escaneos de aquí');
  console.log('  ./ansys-scans delete connected <id>        Borra del dispositivo conectado');
  console.log('');
  console.log('Compatibilidad temporal: local=here, remote=connected');
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const cache = new ScanCache();
  const storage = new BackendStorage();

  if (!command || command === 'help' || command === '--help' || command === '-h') usage(0);

  if (command === 'list') {
    await listScans(storage, cache, parseListOptions(args.slice(1)));
    return;
  }

  if (command === 'local' || command === 'here') {
    await listScans(storage, cache, { scope: 'here', idsOnly: false, max: DEFAULT_LIST_MAX });
    return;
  }

  if (command === 'remote' || command === 'connected') {
    await listScans(storage, cache, { scope: 'connected', idsOnly: false, max: DEFAULT_LIST_MAX });
    return;
  }

  if (command === 'show') {
    const id = args[1];
    if (!id) usage(1);

    const original = await storage.getScan(id);
    if (original) {
      console.log(JSON.stringify(original, null, 2));
      return;
    }

    const cached = await cache.get(id);
    if (cached) {
      console.log(JSON.stringify(cached.scan, null, 2));
      return;
    }

    throw new Error(`El escaneo ${id} no existe en este dispositivo.`);
  }

  if (command === 'delete') {
    const rawTarget = args[1];
    const value = args[2];
    if (!rawTarget || !value) usage(1);
    const target = normalizeTarget(rawTarget);

    if (target === 'here') {
      if (value === '--all') {
        const scans = await storage.listScans();
        let originals = 0;
        for (const scan of scans) {
          if (await storage.deleteScan(scan.id)) originals += 1;
        }
        const copies = await cache.deleteAll();
        console.log(`Escaneos eliminados de este dispositivo: ${originals + copies} (${originals} originales, ${copies} copias)`);
        return;
      }

      const originalRemoved = await storage.deleteScan(value);
      const copyRemoved = await cache.delete(value);
      if (!originalRemoved && !copyRemoved) {
        const connected = await tryFetchConnectedScans();
        if (connected.some((scan) => scan.id === value)) {
          throw new Error(`El escaneo ${value} está en el dispositivo conectado. Usa: ./ansys-scans delete connected ${value}`);
        }
        throw new Error(`El escaneo ${value} no existe en este dispositivo.`);
      }
      console.log(`Escaneo eliminado de este dispositivo: ${value}`);
      return;
    }

    if (value === '--all') {
      throw new Error('Por seguridad, delete connected --all no está habilitado. Borra por ID.');
    }

    const connection = readConnection();
    if (isBackendHostedHere(connection.backendUrl)) {
      throw new Error('El backend configurado apunta a este mismo dispositivo. Usa: ./ansys-scans delete here <id>');
    }

    const response = await request(connection, `/api/scans/${encodeURIComponent(value)}`, { method: 'DELETE' });
    if (response.status === 404) throw new Error(`El escaneo ${value} no existe en el dispositivo conectado.`);
    if (!response.ok) throw new Error(`No se pudo borrar del dispositivo conectado: HTTP ${response.status}.`);
    console.log(`Escaneo eliminado del dispositivo conectado: ${value}`);
    return;
  }

  if (command === 'pull') {
    const value = args[1];
    if (!value) usage(1);
    const connection = readConnection();
    if (isBackendHostedHere(connection.backendUrl)) {
      throw new Error('El dispositivo configurado es este mismo equipo; no hace falta descargar el escaneo.');
    }

    const endpoint = value === 'latest' ? '/api/scans/latest' : `/api/scans/${encodeURIComponent(value)}`;
    const response = await request(connection, endpoint);
    if (!response.ok) throw new Error(`No se pudo copiar el escaneo: HTTP ${response.status}.`);
    const document = await response.json() as unknown;
    if (!isScanDocument(document)) throw new Error('El dispositivo conectado devolvió un documento de escaneo inválido.');

    const cached = await cache.save(document, connection.backendUrl);
    console.log('AnSysWarden · Escaneo copiado a este dispositivo');
    console.log('────────────────────────────────────────');
    console.log(`ID:       ${cached.metadata.scanId}`);
    console.log(`Entradas: ${cached.metadata.entries}`);
    console.log(`Origen:   ${formatOrigin(document)}`);
    console.log(`SHA-256:  ${cached.metadata.sha256}`);
    console.log(`Guardado: ${cached.scanPath}`);
    return;
  }

  usage(1);
}

async function listScans(storage: BackendStorage, cache: ScanCache, options: ListOptions): Promise<void> {
  const allHere = options.scope === 'connected' ? [] : await getHereScans(storage, cache);
  const allConnected = options.scope === 'here' ? [] : await fetchConnectedScans();
  const here = allHere.slice(0, options.max);
  const connected = allConnected.slice(0, options.max);

  console.log('AnSysWarden · Escaneos');
  console.log('────────────────────────────────────────');
  console.log(`Vista: ${options.scope === 'all' ? 'todos' : options.scope}`);
  console.log(`Máximo: ${options.max} por grupo`);
  if (options.idsOnly) console.log('Formato: solo IDs');
  console.log('');

  if (options.scope !== 'connected') {
    console.log(`ESTE DISPOSITIVO (${here.length}/${allHere.length})`);
    if (here.length === 0) {
      console.log('  No hay escaneos en este dispositivo.');
    } else if (options.idsOnly) {
      for (const scan of here) console.log(scan.id);
    } else {
      for (const scan of here) printHereScan(scan);
    }
    console.log('');
  }

  if (options.scope !== 'here') {
    const connection = readConnection();
    if (isBackendHostedHere(connection.backendUrl)) {
      console.log('DISPOSITIVO CONECTADO');
      console.log('  La conexión configurada apunta a este mismo dispositivo.');
    } else {
      console.log(`DISPOSITIVO CONECTADO (${connected.length}/${allConnected.length})`);
      if (connected.length === 0) {
        console.log('  No hay escaneos disponibles en el dispositivo conectado.');
      } else if (options.idsOnly) {
        for (const scan of connected) console.log(scan.id);
      } else {
        for (const scan of connected) printConnectedScan(scan, allHere);
      }
    }
    console.log('');
  }

  if (!options.idsOnly && options.scope === 'all') {
    console.log('Acciones rápidas:');
    console.log('  Solo IDs:       ./ansys-scans list --ids');
    console.log('  Más resultados: ./ansys-scans list --max 25');
    console.log('  Copiar último:  ./ansys-scans pull latest');
    console.log('  Ver aquí:       ./ansys-scans show <id>');
  }
}

async function getHereScans(storage: BackendStorage, cache: ScanCache): Promise<HereScanSummary[]> {
  const [originals, copies] = await Promise.all([storage.listScans(), cache.list()]);
  const byId = new Map<string, HereScanSummary>();

  for (const scan of originals) {
    byId.set(scan.id, { ...scan, kind: 'original' });
  }

  for (const copy of copies) {
    const existing = byId.get(copy.scanId);
    if (existing) {
      existing.kind = 'original+copy';
      existing.cachedAt = copy.cachedAt;
      continue;
    }

    const cached = await cache.get(copy.scanId);
    byId.set(copy.scanId, {
      id: copy.scanId,
      createdAt: copy.createdAt,
      source: copy.source,
      computer: copy.computer,
      entries: copy.entries,
      ...(cached?.scan.origin ? { origin: cached.scan.origin } : {}),
      kind: 'copy',
      cachedAt: copy.cachedAt,
    });
  }

  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function fetchConnectedScans(): Promise<ScanSummary[]> {
  const connection = readConnection();
  if (isBackendHostedHere(connection.backendUrl)) return [];
  const response = await request(connection, '/api/scans');
  if (!response.ok) throw new Error(`El dispositivo conectado respondió HTTP ${response.status}.`);
  const body = await response.json() as { scans?: ScanSummary[] };
  return Array.isArray(body.scans) ? body.scans : [];
}

async function tryFetchConnectedScans(): Promise<ScanSummary[]> {
  try {
    return await fetchConnectedScans();
  } catch {
    return [];
  }
}

function printHereScan(scan: HereScanSummary): void {
  const kind = scan.kind === 'original' ? 'ORIGINAL' : scan.kind === 'copy' ? 'COPIA' : 'ORIGINAL + COPIA';
  console.log(`  ${scan.id}`);
  console.log(`    Estado:   AQUÍ · ${kind}`);
  console.log(`    Origen:   ${formatSummaryOrigin(scan)}`);
  console.log(`    Motor:    ${scan.origin?.scanner ?? scan.source}`);
  console.log(`    Entradas: ${scan.entries}`);
  console.log(`    Ruta:     ${scan.origin?.rootPath ?? '-'}`);
  console.log(`    Fecha:    ${scan.createdAt}`);
  if (scan.cachedAt) console.log(`    Copiado:  ${scan.cachedAt}`);
}

function printConnectedScan(scan: ScanSummary, here: HereScanSummary[]): void {
  const alreadyHere = here.some((item) => item.id === scan.id);
  console.log(`  ${scan.id}`);
  console.log(`    Estado:   CONECTADO${alreadyHere ? ' · YA COPIADO AQUÍ' : ''}`);
  console.log(`    Origen:   ${formatSummaryOrigin(scan)}`);
  console.log(`    Motor:    ${scan.origin?.scanner ?? scan.source}`);
  console.log(`    Entradas: ${scan.entries}`);
  console.log(`    Ruta:     ${scan.origin?.rootPath ?? '-'}`);
  console.log(`    Fecha:    ${scan.createdAt}`);
}

function parseListOptions(args: string[]): ListOptions {
  let scope: ListScope = 'all';
  let idsOnly = false;
  let max = DEFAULT_LIST_MAX;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === 'all') { scope = 'all'; continue; }
    if (arg === 'here' || arg === 'local') { scope = 'here'; continue; }
    if (arg === 'connected' || arg === 'remote') { scope = 'connected'; continue; }
    if (arg === '--ids') { idsOnly = true; continue; }
    if (arg === '--max') {
      const raw = args[index + 1];
      if (!raw) throw new Error('Falta el valor de --max. Ejemplo: --max 10');
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_MAX) {
        throw new Error(`--max debe estar entre 1 y ${MAX_LIST_MAX}.`);
      }
      max = parsed;
      index += 1;
      continue;
    }
    throw new Error(`Opción de listado desconocida: ${arg}`);
  }

  return { scope, idsOnly, max };
}

function normalizeTarget(value: string): 'here' | 'connected' {
  if (value === 'here' || value === 'local') return 'here';
  if (value === 'connected' || value === 'remote') return 'connected';
  throw new Error(`Destino desconocido: ${value}. Usa here o connected.`);
}

function formatOrigin(scan: ScanDocument): string {
  if (!scan.origin) return scan.computer;
  return `${scan.origin.deviceRole.toUpperCase()} · ${scan.origin.hostname} · ${scan.origin.scanner}`;
}

function formatSummaryOrigin(scan: ScanSummary): string {
  if (!scan.origin) return scan.computer;
  return `${scan.origin.deviceRole.toUpperCase()} · ${scan.origin.hostname}`;
}

function readConnection(): { backendUrl: string; token: string } {
  const config = readAppConfig();
  const backendUrl = process.env.ANSYSWARDEN_PC_BACKEND_URL?.trim()
    || config.backendUrl
    || 'http://127.0.0.1:8787';
  const token = process.env.ANSYSWARDEN_API_TOKEN?.trim() || config.apiToken || '';
  if (token.length < 24) throw new Error('Falta la credencial del dispositivo conectado.');
  return { backendUrl: backendUrl.replace(/\/+$/, ''), token };
}

function isBackendHostedHere(backendUrl: string): boolean {
  let hostname: string;
  try { hostname = new URL(backendUrl).hostname; } catch { return false; }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') return true;

  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(entry.address);
  }
  return addresses.has(hostname);
}

async function request(
  connection: { backendUrl: string; token: string },
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${connection.backendUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${connection.token}`, ...(init.headers ?? {}) },
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Scans] ${message}`);
  process.exitCode = 1;
});
