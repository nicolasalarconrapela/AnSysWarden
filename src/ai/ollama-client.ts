import type { AiClassificationPayload, Classification } from './types';

const VALID_CLASSIFICATIONS = new Set<Classification>([
  'SAFE_CACHE',
  'REVIEW_REQUIRED',
  'USER_DATA',
]);

interface OllamaGenerateResponse {
  response?: string;
}

export class OllamaClient {
  constructor(
    private readonly host = process.env.OLLAMA_HOST_URL ?? 'http://127.0.0.1:11434',
    private readonly model = process.env.ANSYSWARDEN_MODEL ?? 'gemma2:2b',
  ) {}

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

    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as OllamaGenerateResponse;
    if (!body.response) {
      throw new Error('Ollama no devolvió contenido en response.');
    }

    return this.parsePayload(body.response);
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
