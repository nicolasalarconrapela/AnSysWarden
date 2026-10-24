import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { ArtifactProfiler } from '../profiler/artifact-profiler';
import { TraceLogger } from '../observability/logger';
import { BridgeClient } from './client';
import { DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT } from './protocol';
import { startBridgeServer } from './server';

function usage(): never {
  console.log('Uso:');
  console.log('  ./ansys bridge token');
  console.log('  ./ansys bridge serve [--host IP] [--port N]');
  console.log('  ./ansys bridge ping');
  console.log('  ./ansys bridge classify <ruta>');
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireToken(): string {
  const token = process.env.ANSYSWARDEN_BRIDGE_TOKEN?.trim();
  if (!token || token.length < 24) {
    throw new Error('ANSYSWARDEN_BRIDGE_TOKEN debe existir y tener al menos 24 caracteres. Genera uno con: ./ansys bridge token');
  }
  return token;
}

async function run(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (command === 'token') {
    console.log(randomBytes(32).toString('hex'));
    return;
  }

  if (command === 'serve') {
    const token = requireToken();
    const host = readOption(args, '--host') ?? DEFAULT_BRIDGE_HOST;
    const rawPort = readOption(args, '--port');
    const port = rawPort ? Number(rawPort) : DEFAULT_BRIDGE_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Puerto inválido: ${String(rawPort)}`);
    startBridgeServer({ host, port, token });
    return;
  }

  if (command === 'ping') {
    requireToken();
    const client = new BridgeClient();
    const health = await client.health();
    console.log('\nAnSysWarden · Bridge Ping');
    console.log('────────────────────────────────────────');
    console.log('Estado: OK');
    console.log(`URL:    ${client.getBaseUrl()}`);
    console.log(`Rol:    ${health.role}`);
    console.log(`Modelo: ${health.model}`);
    console.log(`Hora:   ${health.timestamp}`);
    return;
  }

  if (command === 'classify') {
    const inputPath = args[0];
    if (!inputPath) usage();
    requireToken();

    const logger = new TraceLogger();
    const profiler = new ArtifactProfiler(logger);
    const localPath = resolve(inputPath);

    console.log('\nAnSysWarden · PC → Mobile AI');
    console.log('────────────────────────────────────────');
    console.log(`Perfilando localmente: ${localPath}`);
    const profile = await profiler.profile(localPath);

    const client = new BridgeClient();
    console.log(`Enviando metadatos a: ${client.getBaseUrl()}`);
    const response = await client.classify(localPath, profile);

    console.log('\nResultado');
    console.log('────────────────────────────────────────');
    console.log(`Classification: ${response.result.classification}`);
    console.log(`Confidence:     ${Math.round(response.result.confidence * 100)}%`);
    console.log(`Source:         ${response.result.source}`);
    console.log(`Processed by:   ${response.processedBy}`);
    console.log(`Reason:         ${response.result.reason}`);
    console.log(`Remote time:    ${response.durationMs} ms`);
    console.log('Transfer:       metadata only; no file contents sent');
    console.log('Action:         no files have been deleted');
    return;
  }

  usage();
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Bridge] ${message}`);
  process.exitCode = 1;
});
