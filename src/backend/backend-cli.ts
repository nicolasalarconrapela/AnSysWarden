import { randomBytes } from 'node:crypto';
import { startBackendServer } from './server';

function usage(): never {
  console.log('Usage:');
  console.log('  ./ansys backend token');
  console.log('  ./ansys backend serve [--host IP] [--port N]');
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function run(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (command === 'token') {
    console.log(randomBytes(32).toString('hex'));
    return;
  }

  if (command === 'serve') {
    const token = process.env.ANSYSWARDEN_API_TOKEN?.trim();
    if (!token || token.length < 24) {
      throw new Error('ANSYSWARDEN_API_TOKEN is missing or too short. Generate one with: ./ansys backend token');
    }

    const host = readOption(args, '--host') ?? process.env.ANSYSWARDEN_BACKEND_HOST ?? '0.0.0.0';
    const rawPort = readOption(args, '--port') ?? process.env.ANSYSWARDEN_BACKEND_PORT ?? '8787';
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${rawPort}`);

    await startBackendServer({ host, port, token });
    return;
  }

  usage();
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Backend] ${message}`);
  process.exitCode = 1;
});
