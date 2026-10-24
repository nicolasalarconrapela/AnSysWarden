import { randomUUID } from 'node:crypto';
import type { ArtifactProfile } from '../profiler/artifact-profiler';
import {
  BRIDGE_PROTOCOL,
  type BridgeClassifyRequest,
  type BridgeClassifyResponse,
  type BridgeHealthResponse,
} from './protocol';

export class BridgeClient {
  constructor(
    private readonly baseUrl = process.env.ANSYSWARDEN_BRIDGE_URL ?? 'http://127.0.0.1:8787',
    private readonly token = process.env.ANSYSWARDEN_BRIDGE_TOKEN ?? '',
  ) {
    if (!this.token) {
      throw new Error('Falta ANSYSWARDEN_BRIDGE_TOKEN.');
    }
  }

  getBaseUrl(): string {
    return this.baseUrl.replace(/\/$/, '');
  }

  async health(): Promise<BridgeHealthResponse> {
    const response = await fetch(`${this.getBaseUrl()}/v1/health`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) throw new Error(`Bridge HTTP ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as BridgeHealthResponse;
    if (body.protocol !== BRIDGE_PROTOCOL || body.ok !== true) throw new Error('Respuesta de health incompatible.');
    return body;
  }

  async classify(path: string, profile?: ArtifactProfile): Promise<BridgeClassifyResponse> {
    const request: BridgeClassifyRequest = {
      protocol: BRIDGE_PROTOCOL,
      requestId: randomUUID(),
      path,
      profile,
    };

    const response = await fetch(`${this.getBaseUrl()}/v1/classify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify(request),
    });

    if (!response.ok) throw new Error(`Bridge HTTP ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as BridgeClassifyResponse;
    if (body.protocol !== BRIDGE_PROTOCOL || body.requestId !== request.requestId) {
      throw new Error('Respuesta del bridge incompatible o fuera de correlación.');
    }
    return body;
  }
}
