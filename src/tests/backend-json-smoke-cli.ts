import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BackendStorage } from '../infrastructure/persistence/backend-storage';
import {
  isAiJobDocument,
  isScanDocument,
  type AiJobDocument,
  type ScanDocument,
} from '../core/contracts/backend-protocol';

interface BackendSmokeFile {
  schema: 'ansyswarden.backend-smoke.v1';
  documents: unknown[];
}

export async function runBackendJsonSmoke(inputPath: string): Promise<void> {
  const absolutePath = resolve(inputPath);
  const raw = await readFile(absolutePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  if (!isSmokeFile(parsed)) {
    throw new Error('JSON de prueba inválido: se esperaba ansyswarden.backend-smoke.v1 con documents[].');
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'ansyswarden-backend-smoke-'));
  const storage = new BackendStorage(tempRoot);
  await storage.init();

  let passed = 0;

  try {
    console.log('AnSysWarden · Backend JSON smoke test');
    console.log('────────────────────────────────────────');
    console.log(`Archivo: ${absolutePath}`);
    console.log(`Documentos: ${parsed.documents.length}`);
    console.log('Red: no requerida');
    console.log('Ollama: no requerido');
    console.log('Móvil: no requerido');
    console.log('');

    for (let index = 0; index < parsed.documents.length; index += 1) {
      const document = parsed.documents[index];
      const label = `[${index + 1}/${parsed.documents.length}]`;

      if (isScanDocument(document)) {
        await verifyScan(storage, document);
        console.log(`${label} PASS scan id=${document.id} entries=${document.entries.length}`);
        passed += 1;
        continue;
      }

      if (isAiJobDocument(document)) {
        await verifyAiJob(storage, document);
        console.log(`${label} PASS ai-job id=${document.id}`);
        passed += 1;
        continue;
      }

      throw new Error(`${label} documento no reconocido o inválido.`);
    }

    console.log('');
    console.log(`PASS: ${passed}/${parsed.documents.length}`);
    console.log('FAIL: 0');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function verifyScan(storage: BackendStorage, scan: ScanDocument): Promise<void> {
  await storage.saveScan(scan);
  const saved = await storage.getScan(scan.id);
  if (!saved) throw new Error(`No se pudo recuperar el scan ${scan.id}.`);
  if (JSON.stringify(saved) !== JSON.stringify(scan)) {
    throw new Error(`El scan ${scan.id} cambió durante la persistencia.`);
  }
}

async function verifyAiJob(storage: BackendStorage, job: AiJobDocument): Promise<void> {
  await storage.enqueueAiJob(job);
  const saved = await storage.getAiJob(job.id);
  if (!saved) throw new Error(`No se pudo recuperar el ai-job ${job.id}.`);
  if (JSON.stringify(saved) !== JSON.stringify(job)) {
    throw new Error(`El ai-job ${job.id} cambió durante la persistencia.`);
  }

  const next = await storage.getNextAiJob();
  if (!next) throw new Error(`La cola no devolvió el ai-job ${job.id}.`);
}

function isSmokeFile(value: unknown): value is BackendSmokeFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema === 'ansyswarden.backend-smoke.v1'
    && Array.isArray(record.documents)
    && record.documents.length > 0;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Uso: ./ansys backend test-json <archivo.json>');
  }
  await runBackendJsonSmoke(inputPath);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Backend Test] ${message}`);
  process.exitCode = 1;
});
