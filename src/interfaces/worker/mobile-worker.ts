import { hostname } from 'node:os';
import { PathClassifier } from '../../ai/classifier';
import { OllamaClient } from '../../infrastructure/ollama/ollama-client';
import { TraceLogger } from '../../observability/logger';
import { t } from '../../i18n';
import {
  AI_JOB_RESULT_SCHEMA,
  type AiJobDocument,
  type AiJobResultDocument,
} from '../../core/contracts/backend-protocol';

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8787';
const DEFAULT_POLL_MS = 2_000;

interface WorkerOptions {
  backendUrl: string;
  token: string;
  once: boolean;
  pollMs: number;
}

export async function runMobileWorker(args = process.argv.slice(2)): Promise<void> {
  const options = readOptions(args);
  const logger = new TraceLogger();
  const ollama = new OllamaClient(undefined, undefined, logger);
  const classifier = new PathClassifier(logger, ollama);
  const workerName = process.env.ANSYSWARDEN_WORKER_NAME?.trim() || `mobile-${hostname()}`;

  console.log(t('worker.title'));
  console.log('────────────────────────────────────────');
  console.log(`${t('common.backend')}: ${options.backendUrl}`);
  console.log(`${t('common.worker')}:  ${workerName}`);
  console.log(`${t('common.model')}:   ${ollama.getModel()}`);
  console.log(`${t('common.policy')}: ${t('worker.policy')}`);

  do {
    const job = await fetchNextJob(options);
    if (!job) {
      if (options.once) {
        console.log(t('worker.no_jobs'));
        return;
      }
      await sleep(options.pollMs);
      continue;
    }

    console.log(t('worker.job_received', { jobId: job.id }));
    console.log(`    ${t('common.path')}: ${job.profile.path}`);

    let result = await classifier.classifyProfile(job.profile, { rulesAlreadyChecked: true });

    if (result.classification === 'SAFE_CACHE') {
      result = await classifier.fallbackFromAiError(
        job.profile.path,
        new Error(t('worker.remote_safe_cache')),
      );
    }

    const document: AiJobResultDocument = {
      schema: AI_JOB_RESULT_SCHEMA,
      jobId: job.id,
      worker: workerName,
      model: ollama.getModel(),
      createdAt: new Date().toISOString(),
      result,
    };

    await postResult(options, job.id, document);
    console.log(t('worker.result_sent', { classification: result.classification }));

    if (options.once) return;
  } while (true);
}

function readOptions(args: string[]): WorkerOptions {
  const backendUrl = readOption(args, '--backend')
    ?? process.env.ANSYSWARDEN_PC_BACKEND_URL
    ?? DEFAULT_BACKEND_URL;
  const token = process.env.ANSYSWARDEN_API_TOKEN?.trim() ?? '';
  if (token.length < 24) {
    throw new Error(t('worker.token_missing'));
  }

  const once = args.includes('--once');
  const rawPollMs = readOption(args, '--poll-ms') ?? String(DEFAULT_POLL_MS);
  const pollMs = Number(rawPollMs);
  if (!Number.isInteger(pollMs) || pollMs < 500 || pollMs > 60_000) {
    throw new Error(t('worker.invalid_poll', { value: rawPollMs }));
  }

  return {
    backendUrl: backendUrl.replace(/\/+$/, ''),
    token,
    once,
    pollMs,
  };
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function fetchNextJob(options: WorkerOptions): Promise<AiJobDocument | null> {
  const response = await fetch(`${options.backendUrl}/api/ai/jobs/next`, {
    headers: { Authorization: `Bearer ${options.token}` },
  });

  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(t('worker.backend_next_error', { status: response.status }));
  }
  return await response.json() as AiJobDocument;
}

async function postResult(
  options: WorkerOptions,
  jobId: string,
  result: AiJobResultDocument,
): Promise<void> {
  const response = await fetch(`${options.backendUrl}/api/ai/jobs/${encodeURIComponent(jobId)}/result`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(result),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(t('worker.backend_rejected', { status: response.status, body }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
