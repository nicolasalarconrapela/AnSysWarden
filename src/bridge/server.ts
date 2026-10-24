import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { OllamaClient } from '../ai/ollama-client';
import { PathClassifier } from '../ai/classifier';
import { classifyByRules } from '../ai/rules';
import type { ClassificationResult } from '../ai/types';
import { TraceLogger } from '../observability/logger';
import {
  BRIDGE_PROTOCOL,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  MAX_BRIDGE_BODY_BYTES,
  isBridgeClassifyRequest,
  type BridgeClassifyResponse,
  type BridgeErrorResponse,
  type BridgeHealthResponse,
} from './protocol';

interface BridgeServerOptions {
  host?: string;
  port?: number;
  token: string;
  logger?: TraceLogger;
}

function json(res: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function constantTimeTokenMatch(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

function readBearer(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return null;
  return authorization.slice('Bearer '.length).trim();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BRIDGE_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function startBridgeServer(options: BridgeServerOptions): void {
  const host = options.host ?? process.env.ANSYSWARDEN_BRIDGE_HOST ?? DEFAULT_BRIDGE_HOST;
  const envPort = Number(process.env.ANSYSWARDEN_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT);
  const port = options.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_BRIDGE_PORT);
  const logger = options.logger ?? new TraceLogger();
  const ollama = new OllamaClient(undefined, undefined, logger);
  const classifier = new PathClassifier(logger, ollama);

  const server = createServer(async (req, res) => {
    const startedAt = performance.now();
    const requestUrl = new URL(req.url ?? '/', 'http://ansyswarden.local');

    try {
      if (requestUrl.pathname === '/v1/health' && req.method === 'GET') {
        const token = readBearer(req);
        if (!token || !constantTimeTokenMatch(options.token, token)) {
          json(res, 401, { protocol: BRIDGE_PROTOCOL, error: 'UNAUTHORIZED' } satisfies BridgeErrorResponse);
          return;
        }

        const status = await ollama.health();
        const body: BridgeHealthResponse = {
          protocol: BRIDGE_PROTOCOL,
          ok: true,
          role: 'mobile-ai',
          model: ollama.getModel(),
          timestamp: new Date().toISOString(),
        };
        json(res, status.ok ? 200 : 503, body);
        return;
      }

      if (requestUrl.pathname === '/v1/classify' && req.method === 'POST') {
        const token = readBearer(req);
        if (!token || !constantTimeTokenMatch(options.token, token)) {
          json(res, 401, { protocol: BRIDGE_PROTOCOL, error: 'UNAUTHORIZED' } satisfies BridgeErrorResponse);
          return;
        }

        const body = await readJsonBody(req);
        if (!isBridgeClassifyRequest(body)) {
          json(res, 400, { protocol: BRIDGE_PROTOCOL, error: 'INVALID_REQUEST' } satisfies BridgeErrorResponse);
          return;
        }

        let result: ClassificationResult;
        const ruleResult = classifyByRules(body.path);

        if (ruleResult) {
          result = ruleResult;
        } else if (body.profile) {
          try {
            const ai = await ollama.classifyPath(body.path, undefined, body.profile);
            result = await classifier.applyAiRecommendation(body.path, ai);
          } catch (error) {
            result = await classifier.fallbackFromAiError(body.path, error);
          }
        } else {
          result = await classifier.classify(body.path);
        }

        const response: BridgeClassifyResponse = {
          protocol: BRIDGE_PROTOCOL,
          requestId: body.requestId,
          result,
          processedBy: result.source === 'rule' ? 'rule' : result.source === 'ai' ? 'mobile-ai' : 'fallback',
          durationMs: Math.round(performance.now() - startedAt),
        };

        await logger.info('bridge.classify.complete', 'Clasificación remota completada', {
          request_id: body.requestId,
          input_path: body.path,
          classification: result.classification,
          source: result.source,
          duration_ms: response.durationMs,
        });

        json(res, 200, response);
        return;
      }

      json(res, 404, { protocol: BRIDGE_PROTOCOL, error: 'NOT_FOUND' } satisfies BridgeErrorResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'BODY_TOO_LARGE' ? 413 : 500;
      await logger.error('bridge.request.failed', 'Falló una petición del bridge', {
        method: req.method,
        path: requestUrl.pathname,
        error: message,
      });
      json(res, status, { protocol: BRIDGE_PROTOCOL, error: status === 413 ? 'BODY_TOO_LARGE' : 'INTERNAL_ERROR' } satisfies BridgeErrorResponse);
    }
  });

  server.listen(port, host, () => {
    console.log('\nAnSysWarden · Mobile Bridge');
    console.log('────────────────────────────────────────');
    console.log(`Escuchando: http://${host}:${port}`);
    console.log(`Modelo:     ${ollama.getModel()}`);
    console.log('Seguridad:  Bearer token obligatorio');
    console.log('Ollama:     permanece en 127.0.0.1');
  });
}
