import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BackendStorage } from './storage';
import {
  isAiJobDocument,
  isAiJobResultDocument,
  isSafeId,
  isScanDocument,
  isScanResultDocument,
} from './types';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface BackendServerOptions {
  host?: string;
  port?: number;
  token: string;
  storage?: BackendStorage;
}

export async function startBackendServer(options: BackendServerOptions): Promise<void> {
  const host = options.host ?? process.env.ANSYSWARDEN_BACKEND_HOST ?? '0.0.0.0';
  const envPort = Number(process.env.ANSYSWARDEN_BACKEND_PORT ?? '8787');
  const port = options.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 8787);
  const storage = options.storage ?? new BackendStorage();
  await storage.init();

  const server = createServer(async (req, res) => {
    try {
      if (!authorized(req, options.token)) {
        sendJson(res, 401, { error: 'UNAUTHORIZED' });
        return;
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      if (req.method === 'GET' && path === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          role: 'pc-backend',
          dataDir: storage.root,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (req.method === 'POST' && path === '/api/ai/jobs') {
        const body = await readJsonBody(req);
        if (!isAiJobDocument(body)) return sendJson(res, 400, { error: 'INVALID_AI_JOB' });
        const existing = await storage.getAiJob(body.id);
        const existingResult = await storage.getAiJobResult(body.id);
        if (existing || existingResult) return sendJson(res, 409, { error: 'AI_JOB_ALREADY_EXISTS' });
        await storage.enqueueAiJob(body);
        sendJson(res, 201, { ok: true, id: body.id });
        return;
      }

      if (req.method === 'GET' && path === '/api/ai/jobs/next') {
        const job = await storage.getNextAiJob();
        if (!job) {
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        sendJson(res, 200, job);
        return;
      }

      const aiJobResultMatch = path.match(/^\/api\/ai\/jobs\/([^/]+)\/result$/);
      if (aiJobResultMatch) {
        const jobId = decodeURIComponent(aiJobResultMatch[1]);
        if (!isSafeId(jobId)) return sendJson(res, 400, { error: 'INVALID_AI_JOB_ID' });

        if (req.method === 'GET') {
          const result = await storage.getAiJobResult(jobId);
          if (!result) return sendJson(res, 404, { error: 'AI_JOB_RESULT_NOT_FOUND' });
          sendJson(res, 200, result);
          return;
        }

        if (req.method === 'POST') {
          const job = await storage.getAiJob(jobId);
          if (!job) {
            const existingResult = await storage.getAiJobResult(jobId);
            if (existingResult) return sendJson(res, 409, { error: 'AI_JOB_ALREADY_COMPLETED' });
            return sendJson(res, 404, { error: 'AI_JOB_NOT_FOUND' });
          }

          const body = await readJsonBody(req);
          if (!isAiJobResultDocument(body) || body.jobId !== jobId) {
            return sendJson(res, 400, { error: 'INVALID_AI_JOB_RESULT' });
          }
          if (body.result.path !== job.profile.path) {
            return sendJson(res, 400, { error: 'AI_JOB_PATH_MISMATCH' });
          }

          await storage.saveAiJobResult(body);
          sendJson(res, 201, {
            ok: true,
            jobId,
            classification: body.result.classification,
          });
          return;
        }
      }

      if (req.method === 'GET' && path === '/api/scans') {
        sendJson(res, 200, { scans: await storage.listScans() });
        return;
      }

      if (req.method === 'GET' && path === '/api/scans/latest') {
        const scan = await storage.getLatestScan();
        if (!scan) return sendJson(res, 404, { error: 'SCAN_NOT_FOUND' });
        sendJson(res, 200, scan);
        return;
      }

      if (req.method === 'GET' && path === '/api/ai-inputs/latest') {
        const input = await storage.getLatestAiInput();
        if (!input) return sendJson(res, 404, { error: 'AI_INPUT_NOT_FOUND' });
        sendJson(res, 200, input);
        return;
      }

      if (req.method === 'POST' && path === '/api/scans') {
        const body = await readJsonBody(req);
        if (!isScanDocument(body)) return sendJson(res, 400, { error: 'INVALID_SCAN_DOCUMENT' });
        await storage.saveScan(body);
        sendJson(res, 201, { ok: true, id: body.id, entries: body.entries.length });
        return;
      }

      const aiInputMatch = path.match(/^\/api\/scans\/([^/]+)\/ai-input$/);
      if (req.method === 'GET' && aiInputMatch) {
        const scanId = decodeURIComponent(aiInputMatch[1]);
        if (!isSafeId(scanId)) return sendJson(res, 400, { error: 'INVALID_SCAN_ID' });
        const input = await storage.getAiInput(scanId);
        if (!input) return sendJson(res, 404, { error: 'AI_INPUT_NOT_FOUND' });
        sendJson(res, 200, input);
        return;
      }

      const resultMatch = path.match(/^\/api\/scans\/([^/]+)\/results$/);
      if (resultMatch) {
        const scanId = decodeURIComponent(resultMatch[1]);
        if (!isSafeId(scanId)) return sendJson(res, 400, { error: 'INVALID_SCAN_ID' });

        if (req.method === 'GET') {
          const result = await storage.getResult(scanId);
          if (!result) return sendJson(res, 404, { error: 'RESULT_NOT_FOUND' });
          sendJson(res, 200, result);
          return;
        }

        if (req.method === 'POST') {
          const scan = await storage.getScan(scanId);
          if (!scan) return sendJson(res, 404, { error: 'SCAN_NOT_FOUND' });
          const body = await readJsonBody(req);
          if (!isScanResultDocument(body) || body.scanId !== scanId) {
            return sendJson(res, 400, { error: 'INVALID_RESULT_DOCUMENT' });
          }
          await storage.saveResult(body);
          sendJson(res, 201, { ok: true, scanId, results: body.results.length });
          return;
        }
      }

      const scanMatch = path.match(/^\/api\/scans\/([^/]+)$/);
      if (req.method === 'GET' && scanMatch) {
        const scanId = decodeURIComponent(scanMatch[1]);
        if (!isSafeId(scanId)) return sendJson(res, 400, { error: 'INVALID_SCAN_ID' });
        const scan = await storage.getScan(scanId);
        if (!scan) return sendJson(res, 404, { error: 'SCAN_NOT_FOUND' });
        sendJson(res, 200, scan);
        return;
      }

      sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: 'BODY_TOO_LARGE' });
      if (error instanceof SyntaxError) return sendJson(res, 400, { error: 'INVALID_JSON' });
      console.error('[AnSysWarden Backend]', error);
      sendJson(res, 500, { error: 'INTERNAL_ERROR' });
    }
  });

  server.listen(port, host, () => {
    console.log('\nAnSysWarden · PC Backend');
    console.log('────────────────────────────────────────');
    console.log(`Listening:  http://${host}:${port}`);
    console.log(`Data:       ${storage.root}`);
    console.log('Security:   Bearer token required');
    console.log('Role:       source of truth for scans/results and AI job queue');
  });
}

function authorized(req: IncomingMessage, expected: string): boolean {
  const value = req.headers.authorization;
  if (!value?.startsWith('Bearer ')) return false;
  const received = value.slice('Bearer '.length).trim();
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
