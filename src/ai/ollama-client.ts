import type { AiClassificationPayload, Classification } from './types';
import { TraceLogger } from '../observability/logger';

const VALID_CLASSIFICATIONS = new Set<Classification>([
  'SAFE_CACHE',
  'REVIEW_REQUIRED',
  'USER_DATA',
]);

interface OllamaGenerateResponse {
  response?: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

export class OllamaClient {
  constructor(
    private readonly host = process.env.OLLAMA_HOST_URL ?? 'http://127.0.0.1:11434',
    private readonly model = process.env.ANSYSWARDEN_MODEL ?? 'gemma2:2b',
    private readonly logger?: TraceLogger,
  ) {}

  getHost(): string {
    return this.host;
  }

  getModel(): string {
    return this.model;
  }

  async health(): Promise<{ ok: boolean; models: string[] }> {
    const response = await fetch(`${this.host}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as OllamaTagsResponse;
    const models = (body.models ?? [])
      .map((item) => item.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);

    return { ok: true, models };
  }

  async classifyPath(inputPath: string): Promise<AiClassificationPayload> {
    const prompt = [
      'Eres el clasificador de seguridad de AnSysWarden.',
      'Tu trabajo es clasificar rutas de archivos sin borrar ni modificar nada.',
      'Devuelve SOLO JSON válido con este formato exacto:',
      '{"classification":"SAFE_CACHE|REVIEW_REQUIRED|USER_DATA","confidence":0.0,"reason":"texto breve"}',
      '',
      'Criterios:',
      '- SAFE_CACHE: artefactos claramente regenerables, temporales o cachés.',
      '- USER_DATA: archivos personales, documentos, fotos, vídeos, descargas o datos potencialmente únicos.',
      '- REVIEW_REQUIRED: cualquier caso ambiguo o del que no estés seguro.',
      '- Ante duda, usa REVIEW_REQUIRED.',
      '',
      `Ruta: ${inputPath}`,
    ].join('\n');

    const startedAt = performance.now();
    await this.logger?.info('ollama.request', 'Enviando clasificación a Gemma', {
      host: this.host,
      model: this.model,
      input_path: inputPath,
    });

    const response = await fetch(`${this.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
      }),
    });

    const durationMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      const body = await response.text();
      await this.logger?.error('ollama.response.error', 'Ollama devolvió un error', {
        host: this.host,
        model: this.model,
        status: response.status,
        duration_ms: durationMs,
        body,
      });
      throw new Error(`Ollama HTTP ${response.status}: ${body}`);
    }

    const body = (await response.json()) as OllamaGenerateResponse;
    if (!body.response) {
      throw new Error('Ollama no devolvió contenido en response.');
    }

    const parsed = this.parsePayload(body.response);
    await this.logger?.info('ollama.response', 'Gemma respondió correctamente', {
      host: this.host,
      model: this.model,
      input_path: inputPath,
      duration_ms: durationMs,
      classification: parsed.classification,
      confidence: parsed.confidence,
    });

    return parsed;
  }

  private parsePayload(raw: string): AiClassificationPayload {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Gemma devolvió JSON inválido: ${raw}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('La respuesta de Gemma no es un objeto JSON.');
    }

    const candidate = parsed as Record<string, unknown>;
    const classification = candidate.classification;
    const confidence = candidate.confidence;
    const reason = candidate.reason;

    if (typeof classification !== 'string' || !VALID_CLASSIFICATIONS.has(classification as Classification)) {
      throw new Error(`Clasificación inválida recibida de Gemma: ${String(classification)}`);
    }

    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`Confianza inválida recibida de Gemma: ${String(confidence)}`);
    }

    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error('Gemma no devolvió una razón válida.');
    }

    return {
      classification: classification as Classification,
      confidence,
      reason: reason.trim(),
    };
  }
}
