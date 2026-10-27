import { runMobileWorker } from '../interfaces/worker/mobile-worker';

runMobileWorker().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Mobile Worker] ${message}`);
  process.exitCode = 1;
});
