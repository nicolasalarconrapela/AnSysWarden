import { readAppConfig } from '../../config/app-config';
import { isScanDocument, type ScanDocument, type ScanOrigin } from '../../core/contracts/backend-protocol';
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

function usage(exitCode = 0): never {
  console.log('AnSysWarden · Escaneos');
  console.log('────────────────────────────────────────');
  console.log('Uso principal:');
  console.log('  ./ansys-scans list                 Lista remotos + locales');
  console.log('  ./ansys-scans list remote          Lista solo el backend');
  console.log('  ./ansys-scans list local           Lista copias offline');
  console.log('');
  console.log('Descarga y consulta:');
  console.log('  ./ansys-scans pull latest          Descarga el escaneo más reciente');
  console.log('  ./ansys-scans pull <id>            Descarga un escaneo concreto');
  console.log('  ./ansys-scans show <id>            Muestra el JSON local completo');
  console.log('');
  console.log('Limpieza local:');
  console.log('  ./ansys-scans delete local <id>    Elimina una copia local');
  console.log('  ./ansys-scans delete local --all   Elimina todas las copias locales');
  console.log('');
  console.log('Ayuda:');
  console.log('  ./ansys-scans help');
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const [, , command, value, extra] = process.argv;
  const cache = new ScanCache();

  if (!command || command === 'help' || command === '--help' || command === '-h') usage(0);

  if (command === 'list') {
    const scope = normalizeListScope(value);
    await listScans(cache, scope);
    return;
  }

  // Compatibility with the previous commands.
  if (command === 'local') {
    await listScans(cache, 'local');
    return;
  }

  if (command === 'remote') {
    await listScans(cache, 'remote');
    return;
  }

  if (command === 'show') {
    if (!value) usage(1);
    const cached = await cache.get(value);
    if (!cached) throw new Error(`No existe una copia local válida del escaneo ${value}.`);
    console.log(JSON.stringify(cached.scan, null, 2));
    return;
  }

  if (command === 'delete') {
    if (value !== 'local' || !extra) usage(1);

    if (extra === '--all') {
      const count = await cache.deleteAll();
      console.log(`Escaneos locales eliminados: ${count}`);
      return;
    }

    const removed = await cache.delete(extra);
    if (!removed) throw new Error(`No existe el escaneo local ${extra}.`);
    console.log(`Escaneo local eliminado: ${extra}`);
    return;
  }

  if (command === 'pull') {
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

async function listScans(cache: ScanCache, scope: ListScope): Promise<void> {
  const localRows = scope === 'remote' ? [] : await cache.list();
  const remoteRows = scope === 'local' ? [] : await fetchRemoteScans();

  console.log('AnSysWarden · Escaneos');
  console.log('────────────────────────────────────────');
  console.log(`Vista: ${scope === 'all' ? 'todos' : scope}`);
  console.log('');

  if (scope !== 'local') {
    console.log(`REMOTOS (${remoteRows.length})`);
    if (remoteRows.length === 0) {
      console.log('  No hay escaneos remotos disponibles.');
    } else {
      for (const scan of remoteRows) printRemoteScan(scan, localRows);
    }
    console.log('');
  }

  if (scope !== 'remote') {
    console.log(`LOCALES (${localRows.length})`);
    if (localRows.length === 0) {
      console.log('  No hay copias locales descargadas.');
    } else {
      for (const scan of localRows) printLocalScan(scan);
    }
    console.log('');
  }

  if (scope === 'all') {
    console.log('Acciones rápidas:');
    console.log('  Descargar último: ./ansys-scans pull latest');
    console.log('  Ver local:        ./ansys-scans show <id>');
    console.log('  Ayuda completa:   ./ansys-scans help');
  }
}

async function fetchRemoteScans(): Promise<RemoteScanSummary[]> {
  const connection = readConnection();
  const response = await request(connection, '/api/scans');
  if (!response.ok) throw new Error(`Backend respondió HTTP ${response.status}.`);
  const body = await response.json() as { scans?: RemoteScanSummary[] };
  return Array.isArray(body.scans) ? body.scans : [];
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

function normalizeListScope(value: string | undefined): ListScope {
  if (!value || value === 'all') return 'all';
  if (value === 'local' || value === 'remote') return value;
  throw new Error(`Vista desconocida: ${value}. Usa all, local o remote.`);
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
