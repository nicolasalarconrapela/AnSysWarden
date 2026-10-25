import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TraceEvent {
  ts: string;
  run_id: string;
  level: TraceLevel;
  event: string;
  phase?: string;
  message: string;
  duration_ms?: number;
  data?: Record<string, unknown>;
}

export interface LoggerOptions {
  runId?: string;
  logFile?: string;
  human?: boolean;
}

export class TraceLogger {
  readonly runId: string;
  readonly logFile: string;
  private readonly human: boolean;

  constructor(options: LoggerOptions = {}) {
    this.runId = options.runId ?? randomUUID();
    this.logFile = resolve(
      options.logFile ?? process.env.ANSYSWARDEN_LOG_FILE ?? `.ansyswarden/logs/${this.runId}.jsonl`,
    );
    this.human = options.human ?? true;
  }

  debug(event: string, message: string, data?: Record<string, unknown>): Promise<void> {
    return this.write('debug', event, message, data);
  }

  info(event: string, message: string, data?: Record<string, unknown>): Promise<void> {
    return this.write('info', event, message, data);
  }

  warn(event: string, message: string, data?: Record<string, unknown>): Promise<void> {
    return this.write('warn', event, message, data);
  }

  error(event: string, message: string, data?: Record<string, unknown>): Promise<void> {
    return this.write('error', event, message, data);
  }

  async span<T>(
    event: string,
    message: string,
    operation: () => Promise<T>,
    data?: Record<string, unknown>,
  ): Promise<T> {
    const startedAt = performance.now();
    await this.info(`${event}.start`, `${message} · inicio`, data);

    try {
      const result = await operation();
      const durationMs = Math.round(performance.now() - startedAt);
      await this.write('info', `${event}.success`, `${message} · completado`, data, durationMs);
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      const technicalError = serializeError(error);
      await this.write(
        'error',
        `${event}.failed`,
        `${message} · error`,
        { ...data, error: technicalError },
        durationMs,
      );
      throw error;
    }
  }

  private async write(
    level: TraceLevel,
    event: string,
    message: string,
    data?: Record<string, unknown>,
    durationMs?: number,
  ): Promise<void> {
    const trace: TraceEvent = {
      ts: new Date().toISOString(),
      run_id: this.runId,
      level,
      event,
      message,
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      ...(data ? { data } : {}),
    };

    if (this.human) {
      const icon = level === 'error' ? '✗' : level === 'warn' ? '!' : level === 'debug' ? '·' : '✓';
      const suffix = durationMs === undefined ? '' : ` (${durationMs} ms)`;
      const stream = level === 'error' || level === 'warn' ? console.error : console.log;
      stream(`[${icon}] ${message}${suffix}`);
    }

    await mkdir(dirname(this.logFile), { recursive: true });
    await appendFile(this.logFile, `${JSON.stringify(trace)}\n`, 'utf8');
  }
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause instanceof Error ? serializeError(error.cause) : error.cause,
    };
  }

  return { value: String(error) };
}
