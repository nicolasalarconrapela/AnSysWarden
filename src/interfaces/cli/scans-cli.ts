import { readAppConfig } from '../../config/app-config';
import { isScanDocument, type ScanDocument } from '../../core/contracts/backend-protocol';
import { ScanCache } from '../../infrastructure/persistence/scan-cache';

interface RemoteScanSummary {
  id: string;
  createdAt: string;
  source: string;
  computer: string;
  entries: number;
}

function usage(): never {
  console.log('Uso:');
  console.log('  ./ansys-scans remote');
  console.log('  ./ansys-scans pull <id|latest>');
  console.log('  ./ansys-scans local');
  console.log('  ./ansys-scans show <id>');
  console.log('  ./ansys-scans delete local <id>');
  console.log('  ./ansys-scans delete local --all');
  process.exit(1);
}

async function main(): Promise<void> {
  const [, , command, value, extra] = process.argv;
  const cache = new ScanCache();

  if (command === 'local') {
    const rows = await cache.list();
    console.log('AnSysWarden · Escaneos locales');
    console.log('────────────────────────────────────────');
    if (rows.length === 0) {
      console.log('No hay escaneos descargados.');
      return;
    }
    for (const row of rows) {
      console.log(`${row.scanId} | ${row.entries} entradas | ${row.computer} | ${row.cachedAt}`);
    }
    return;
  }

  if (command === 'show') {
    if (!value) usage();
    const cached = await cache.get(value);
    if (!cached) throw new Error(`No existe una copia local válida del escaneo ${value}.`);
    console.log(JSON.stringify(cached.scan, null, 2));
    return;
  }

  if (command === 'delete') {
    if (value !== 'local' || !extra) usage();

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

  if (command === 'remote') {
    const connection = readConnection();
    const response = await request(connection, '/api/scans');
    if (!response.ok) throw new Error(`Backend respondió HTTP ${response.status}.`);
    const body = await response.json() as { scans?: RemoteScanSummary[] };
    const scans = Array.isArray(body.scans) ? body.scans : [];

    console.log('AnSysWarden · Escaneos remotos');
    console.log('────────────────────────────────────────');
    if (scans.length === 0) {
      console.log('El backend no tiene escaneos disponibles.');
      return;
    }
    for (const scan of scans) {
      console.log(`${scan.id} | ${scan.entries} entradas | ${scan.computer} | ${scan.createdAt}`);
    }
    return;
  }

  if (command === 'pull') {
    if (!value) usage();
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
    console.log(`Origen:   ${cached.metadata.computer}`);
    console.log(`SHA-256:  ${cached.metadata.sha256}`);
    console.log(`Local:    ${cached.scanPath}`);
    console.log('Disponible para reutilización offline.');
    return;
  }

  usage();
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
