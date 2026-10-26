import { hostname } from 'node:os';
import { PathClassifier } from '../ai/classifier';
import { OllamaClient } from '../ai/ollama-client';
import { TraceLogger } from '../observability/logger';
import {
  AI_JOB_RESULT_SCHEMA,
  type AiJobDocument,
  type AiJobResultDocument,
} from '../backend/types';

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8787';
const DEFAULT_POLL_MS = 2_000;

interface WorkerOptions {
  backendUrl: string;
  token: string;
  once: boolean;
  pollMs: number;
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  const logger = new TraceLogger();
  const ollama = new OllamaClient(undefined, undefined, logger);
  const classifier = new PathClassifier(logger, ollama);
  const workerName = process.env.ANSYSWARDEN_WORKER_NAME?.trim() || `mobile-${hostname()}`;

  console.log('AnSysWarden · Mobile Worker');
  console.log('────────────────────────────────────────');
  console.log(`Backend: ${options.backendUrl}`);
  console.log(`Worker:  ${workerName}`);
  console.log(`Model:   ${ollama.getModel()}`);
  console.log('Policy: the mobile worker can never authorize SAFE_CACHE.');

  do {
    const job = await fetchNextJob(options);
    if (!job) {
      if (options.once) {
        console.log('[·] No pending jobs.');
        return;
      }
      await sleep(options.pollMs);
      continue;
    }

    console.log(`[✓] Job received: ${job.id}`);
    console.log(`    Path: ${job.profile.path}`);

    let result = await classifier.classifyProfile(job.profile, { rulesAlreadyChecked: true });

    // Defense in depth: even if the classifier changes in the future,
    // the mobile worker must never send SAFE_CACHE back to the PC.
    if (result.classification === 'SAFE_CACHE') {
      result = await classifier.fallbackFromAiError(
        job.profile.path,
        new Error('The mobile worker received SAFE_CACHE, which is not an authorized remote AI classification.'),
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
    console.log(`[✓] Result sent: ${result.classification}`);

    if (options.once) return;
  } while (true);
}

function readOptions(args: string[]): WorkerOptions {
  const backendUrl = readOption(args, '--backend')
    ?? process.env.ANSYSWARDEN_PC_BACKEND_URL
    ?? DEFAULT_BACKEND_URL;
  const token = process.env.ANSYSWARDEN_API_TOKEN?.trim() ?? '';
  if (token.length < 24) {
    throw new Error('ANSYSWARDEN_API_TOKEN is missing or too short. It must match the PC backend token.');
  }

  const once = args.includes('--once');
  const rawPollMs = readOption(args, '--poll-ms') ?? String(DEFAULT_POLL_MS);
  const pollMs = Number(rawPollMs);
  if (!Number.isInteger(pollMs) || pollMs < 500 || pollMs > 60_000) {
    throw new Error(`Invalid --poll-ms: ${rawPollMs}. Use a value between 500 and 60000.`);
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
    throw new Error(`Backend returned ${response.status} while requesting the next job.`);
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
    throw new Error(`Backend rejected the result (${response.status}): ${body}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Mobile Worker] ${message}`);
  process.exitCode = 1;
});
