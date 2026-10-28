import { networkInterfaces } from 'node:os';
import { readAppConfig } from '../../config/app-config';
import { isScanDocument, type ScanDocument, type ScanOrigin } from '../../core/contracts/backend-protocol';
import { BackendStorage } from '../../infrastructure/persistence/backend-storage';
import { ScanCache, type CachedScanMetadata } from '../../infrastructure/persistence/scan-cache';

interface RemoteScanSummary {
  id: string;
  createdAt: string;
  source: string;
  computer: string;
  entries: number;
  origin?: ScanOrigin;
}

type ListScope = 'all' | 'local' | 'remote';

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
  console.log('Listados:');
  console.log('  ./ansys-scans list                       Últimos 10 remotos + locales');
  console.log('  ./ansys-scans list --ids                 Solo IDs');
  console.log('  ./ansys-scans list --max 25              Muestra hasta 25 por grupo');
  console.log('  ./ansys-scans list remote                Solo backend');
  console.log('  ./ansys-scans list local                 Solo copias offline');
  console.log('  ./ansys-scans list remote --ids --max 20 Combina filtros');
  console.log('');
  console.log('Descarga y consulta:');
  console.log('  ./ansys-scans pull latest                Descarga el escaneo más reciente');
  console.log('  ./ansys-scans pull <id>                  Descarga un escaneo concreto');
  console.log('  ./ansys-scans show <id>                  Muestra el JSON local completo');
  console.log('');
  console.log('Limpieza:');
  console.log('  ./ansys-scans delete local <id>          Elimina una copia local');
  console.log('  ./ansys-scans delete local --all         Elimina todas las copias locales');
  console.log('  ./ansys-scans delete remote <id>         Elimina del backend alojado aquí');
  console.log('');
  console.log('Ayuda:');
  console.log('  ./ansys-scans help');
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const cache = new ScanCache();

  if (!command || command === 'help' || command === '--help' || command === '-h') usage(0);

  if (command === 'list') {
    await listScans(cache, parseListOptions(args.slice(1)));
    return;
  }

  if (command === 'local') {
    await listScans(cache, { scope: 'local', idsOnly: false, max: DEFAULT_LIST_MAX });
    return;
  }

  if (command === 'remote') {
    await listScans(cache, { scope: 'remote', idsOnly: false, max: DEFAULT_LIST_MAX });
    return;
  }

  if (command === 'show') {
    const value = args[1];
    if (!value) usage(1);
    const cached = await cache.get(value);
    if (!cached) throw new Error(`No existe una copia local válida del escaneo ${value}.`);
    console.log(JSON.stringify(cached.scan, null, 2));
    return;
  }

  if (command === 'delete') {
    const target = args[1];
    const value = args[2];
    if (!target || !value) usage(1);

    if (target === 'local') {
      if (value === '--all') {
        const count = await cache.deleteAll();
        console.log(`Escaneos locales eliminados: ${count}`);
        return;
      }

      const removed = await cache.delete(value);
      if (!removed) {
        const remoteRows = await tryFetchRemoteScans();
        if (remoteRows.some((scan) => scan.id === value)) {
          throw new Error(`El escaneo ${value} no es local; existe en REMOTOS. Usa: ./ansys-scans delete remote ${value}`);
        }
        throw new Error(`No existe el escaneo local ${value}.`);
      }
      console.log(`Escaneo local eliminado: ${value}`);
      return;
    }

    if (target === 'remote') {
      if (value === '--all') {
        throw new Error('Por seguridad, delete remote --all no está habilitado. Borra por ID.');
      }

      const connection = readConnection();
      if (!isBackendHostedHere(connection.backendUrl)) {
        throw new Error('El backend configurado está en otro dispositivo. La eliminación remota por HTTP todavía no está habilitada. Ejecuta este comando en el equipo que aloja el backend.');
      }

      const storage = new BackendStorage();
      const removed = await storage.deleteScan(value);
      if (!removed) throw new Error(`No existe el escaneo remoto ${value}.`);
      console.log(`Escaneo remoto eliminado del backend: ${value}`);
      return;
    }

    usage(1);
  }

  if (command === 'pull') {
    const value = args[1];
    if (!value) usage(1);
    const connection = readConnection();
    const endpoint = value === 'latest' ? '/api/scans/latest' : `/api/scans/${encodeURIComponent(value)}`;
    const response = await request(connection, endpoint);
    if (!response.ok) throw new Error(`No se pudo descargar el escaneo: HTTP ${response.status}.`);
    const document = await response.json() as unknown;
    if (!isScanDocument(document)) throw new Error('El backend devolvió un documento de escaneo inválido.');

    const cached = await cache.save(document, connection.backendUrl);
    console.log('AnSysWarden · Escaneo descargado');
    console.log('────────────────────────────────────────');
    console.log(`ID:       ${cached.metadata.scanId}`);
    console.log(`Entradas: ${cached.metadata.entries}`);
    console.log(`Origen:   ${formatOrigin(document)}`);
    console.log(`SHA-256:  ${cached.metadata.sha256}`);
    console.log(`Local:    ${cached.scanPath}`);
    console.log('Estado:   disponible offline');
    return;
  }

  usage(1);
}

async function listScans(cache: ScanCache, options: ListOptions): Promise<void> {
  const allLocalRows = options.scope === 'remote' ? [] : await cache.list();
  const allRemoteRows = options.scope === 'local' ? [] : await fetchRemoteScans();
  const localRows = allLocalRows.slice(0, options.max);
  const remoteRows = allRemoteRows.slice(0, options.max);

  console.log('AnSysWarden · Escaneos');
  console.log('────────────────────────────────────────');
  console.log(`Vista: ${options.scope === 'all' ? 'todos' : options.scope}`);
  console.log(`Máximo: ${options.max} por grupo`);
  if (options.idsOnly) console.log('Formato: solo IDs');
  console.log('');

  if (options.scope !== 'local') {
    console.log(`REMOTOS (${remoteRows.length}/${allRemoteRows.length})`);
    if (remoteRows.length === 0) {
      console.log('  No hay escaneos remotos disponibles.');
    } else if (options.idsOnly) {
      for (const scan of remoteRows) console.log(scan.id);
    } else {
      for (const scan of remoteRows) printRemoteScan(scan, allLocalRows);
    }
    console.log('');
  }

  if (options.scope !== 'remote') {
    console.log(`LOCALES (${localRows.length}/${allLocalRows.length})`);
    if (localRows.length === 0) {
      console.log('  No hay copias locales descargadas.');
    } else if (options.idsOnly) {
      for (const scan of localRows) console.log(scan.scanId);
    } else {
      for (const scan of localRows) printLocalScan(scan);
    }
    console.log('');
  }

  if (!options.idsOnly && options.scope === 'all') {
    console.log('Acciones rápidas:');
    console.log('  Solo IDs:         ./ansys-scans list --ids');
    console.log('  Más resultados:   ./ansys-scans list --max 25');
    console.log('  Descargar último: ./ansys-scans pull latest');
    console.log('  Ver local:        ./ansys-scans show <id>');
  }
}

function parseListOptions(args: string[]): ListOptions {
  let scope: ListScope = 'all';
  let idsOnly = false;
  let max = DEFAULT_LIST_MAX;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === 'all' || arg === 'local' || arg === 'remote') {
      scope = arg;
      continue;
    }

    if (arg === '--ids') {
      idsOnly = true;
      continue;
    }

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

async function fetchRemoteScans(): Promise<RemoteScanSummary[]> {
  const connection = readConnection();
  const response = await request(connection, '/api/scans');
  if (!response.ok) throw new Error(`Backend respondió HTTP ${response.status}.`);
  const body = await response.json() as { scans?: RemoteScanSummary[] };
  return Array.isArray(body.scans) ? body.scans : [];
}

async function tryFetchRemoteScans(): Promise<RemoteScanSummary[]> {
  try {
    return await fetchRemoteScans();
  } catch {
    return [];
  }
}

function printRemoteScan(scan: RemoteScanSummary, localRows: CachedScanMetadata[]): void {
  const downloaded = localRows.some((row) => row.scanId === scan.id);
  const role = scan.origin?.deviceRole?.toUpperCase() ?? 'DESCONOCIDO';
  const scanner = scan.origin?.scanner ?? scan.source;
  const root = scan.origin?.rootPath ?? '-';
  const state = downloaded ? 'REMOTO + LOCAL' : 'REMOTO';

  console.log(`  ${scan.id}`);
  console.log(`    Estado:   ${state}`);
  console.log(`    Origen:   ${role} · ${scan.computer}`);
  console.log(`    Motor:    ${scanner}`);
  console.log(`    Entradas: ${scan.entries}`);
  console.log(`    Ruta:     ${root}`);
  console.log(`    Fecha:    ${scan.createdAt}`);
}

function printLocalScan(scan: CachedScanMetadata): void {
  console.log(`  ${scan.scanId}`);
  console.log('    Estado:   LOCAL · offline');
  console.log(`    Origen:   ${scan.computer}`);
  console.log(`    Motor:    ${scan.source}`);
  console.log(`    Entradas: ${scan.entries}`);
  console.log(`    Escaneo:  ${scan.createdAt}`);
  console.log(`    Descarga: ${scan.cachedAt}`);
}

function formatOrigin(scan: ScanDocument): string {
  if (!scan.origin) return scan.computer;
  return `${scan.origin.deviceRole.toUpperCase()} · ${scan.origin.hostname} · ${scan.origin.scanner}`;
}

function readConnection(): { backendUrl: string; token: string } {
  const config = readAppConfig();
  const backendUrl = process.env.ANSYSWARDEN_PC_BACKEND_URL?.trim()
    || config.backendUrl
    || 'http://127.0.0.1:8787';
  const token = process.env.ANSYSWARDEN_API_TOKEN?.trim() || config.apiToken || '';
  if (token.length < 24) {
    throw new Error('Falta el token del backend. Configúralo o usa ANSYSWARDEN_API_TOKEN.');
  }
  return { backendUrl: backendUrl.replace(/\/+$/, ''), token };
}

function isBackendHostedHere(backendUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(backendUrl).hostname;
  } catch {
    return false;
  }

  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
    return true;
  }

  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(entry.address);
  }
  return addresses.has(hostname);
}

async function request(connection: { backendUrl: string; token: string }, path: string): Promise<Response> {
  return fetch(`${connection.backendUrl}${path}`, {
    headers: { Authorization: `Bearer ${connection.token}` },
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Scans] ${message}`);
  process.exitCode = 1;
});
