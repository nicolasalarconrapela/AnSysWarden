import { basename, resolve } from 'node:path';
import { TraceLogger } from '../observability/logger';
import { formatBytes } from '../scanner/scanner';
import { ArtifactProfiler } from './artifact-profiler';

function formatDate(ms: number | null): string {
  if (ms === null) return 'n/a';
  return new Date(ms).toISOString();
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.error('Uso: inspect-cli <ruta>');
    process.exitCode = 1;
    return;
  }

  const logger = new TraceLogger();
  const profiler = new ArtifactProfiler(logger);
  const profile = await profiler.profile(resolve(input));

  console.log('\nAnSysWarden · Artifact Inspect');
  console.log('════════════════════════════════════════════════════');
  console.log(`Nombre:       ${basename(profile.path) || profile.path}`);
  console.log(`Ruta:         ${profile.path}`);
  console.log(`Tamaño:       ${formatBytes(profile.sizeBytes)}`);
  console.log(`Archivos:     ${profile.fileCount}`);
  console.log(`Directorios:  ${profile.directoryCount}`);
  console.log(`Omitidos:     ${profile.skippedEntries}`);
  console.log(`Más antiguo:  ${formatDate(profile.oldestMtimeMs)}`);
  console.log(`Más reciente: ${formatDate(profile.newestMtimeMs)}`);

  console.log('\nTIPOS DE ARCHIVO DOMINANTES');
  console.log('────────────────────────────────────────────────────');
  if (profile.extensions.length === 0) {
    console.log('(sin archivos detectados)');
  } else {
    for (const row of profile.extensions) {
      const pct = profile.sizeBytes > 0 ? Math.round((row.bytes / profile.sizeBytes) * 100) : 0;
      console.log(`${row.extension.padEnd(18)} ${String(row.files).padStart(7)} archivos   ${formatBytes(row.bytes).padStart(10)}   ${String(pct).padStart(3)}%`);
    }
  }

  console.log('\nEN HUMANO');
  console.log('🧭 Esto describe qué hay realmente dentro de la carpeta.');
  console.log('🤖 Todavía no estamos preguntando a Gemma si es caché o no.');
  console.log('🛡️ No se ha borrado ni modificado ningún archivo.');
  console.log(`\nTraza: ${logger.logFile}`);
}

main().catch((error: unknown) => {
  console.error('[AnSysWarden] Error al inspeccionar:', error);
  process.exitCode = 1;
});
