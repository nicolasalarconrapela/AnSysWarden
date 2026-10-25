import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { PathClassifier } from '../ai/classifier';
import { OllamaClient } from '../ai/ollama-client';
import { TraceLogger } from '../observability/logger';

function sanitizePath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/');
  const home = homedir().replace(/\\/g, '/');

  let sanitized = normalized;
  if (home && sanitized.startsWith(home)) {
    sanitized = `~${sanitized.slice(home.length)}`;
  }

  sanitized = sanitized
    .replace(/^\/home\/[^/]+(?=\/|$)/i, '~')
    .replace(/^([A-Za-z]:)\/Users\/[^/]+(?=\/|$)/i, '$1/Users/<USER>');

  return sanitized;
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    throw new Error('Uso: export-review <ruta>');
  }

  const logger = new TraceLogger();
  const classifier = new PathClassifier(logger);
  const ollama = new OllamaClient(undefined, undefined, logger);
  const absolutePath = resolve(input);
  const result = await classifier.classify(absolutePath);
  const sanitizedPath = sanitizePath(absolutePath);

  const payload = {
    schema: 'ansyswarden-review-v1',
    generated_at: new Date().toISOString(),
    privacy: {
      local_only: true,
      automatically_uploaded: false,
      contains_file_contents: false,
      path_sanitized: sanitizedPath !== absolutePath,
      note: 'Este JSON se crea localmente. AnSysWarden no lo envía a ningún servidor.',
    },
    case: {
      path: sanitizedPath,
      classification: result.classification,
      confidence: result.source === 'fallback' ? null : result.confidence,
      source: result.source,
      reason: result.reason,
    },
    ai: {
      model: ollama.getModel(),
      role: 'advisor_only',
      can_authorize_safe_cache: false,
    },
    policy: {
      safe_cache_requires_local_rule: true,
      human_final_decision: true,
    },
  };

  const reviewDir = join(dirname(logger.logFile), '..', 'reviews');
  await mkdir(reviewDir, { recursive: true });
  const output = join(reviewDir, `${logger.runId}.json`);
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log('\nAnSysWarden · Review Export');
  console.log('════════════════════════════════════════════════════');
  console.log(`Ruta:          ${sanitizedPath}`);
  console.log(`Clasificación: ${result.classification}`);
  console.log(`Fuente:        ${result.source}`);
  console.log(`Archivo:       ${output}`);
  console.log('Privacidad:    LOCAL. No se ha enviado nada a Internet.');
  console.log('Contenido:     No incluye contenido de archivos; solo contexto de clasificación.');
  console.log('\nPuedes revisar manualmente este JSON con otra IA si tú decides compartirlo.');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden] No se pudo exportar la revisión: ${message}`);
  process.exitCode = 1;
});
