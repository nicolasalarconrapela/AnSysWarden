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
    console.error('Usage: inspect-cli <path>');
    process.exitCode = 1;
    return;
  }

  const logger = new TraceLogger();
  const profiler = new ArtifactProfiler(logger);
  const profile = await profiler.profile(resolve(input));

  console.log('\nAnSysWarden · Artifact Inspect');
  console.log('════════════════════════════════════════════════════');
  console.log(`Name:        ${basename(profile.path) || profile.path}`);
  console.log(`Path:        ${profile.path}`);
  console.log(`Size:        ${formatBytes(profile.sizeBytes)}`);
  console.log(`Files:       ${profile.fileCount}`);
  console.log(`Directories: ${profile.directoryCount}`);
  console.log(`Skipped:     ${profile.skippedEntries}`);
  console.log(`Oldest:      ${formatDate(profile.oldestMtimeMs)}`);
  console.log(`Newest:      ${formatDate(profile.newestMtimeMs)}`);

  console.log('\nDOMINANT FILE TYPES');
  console.log('────────────────────────────────────────────────────');
  if (profile.extensions.length === 0) {
    console.log('(no files detected)');
  } else {
    for (const row of profile.extensions) {
      const pct = profile.sizeBytes > 0 ? Math.round((row.bytes / profile.sizeBytes) * 100) : 0;
      console.log(`${row.extension.padEnd(18)} ${String(row.files).padStart(7)} files   ${formatBytes(row.bytes).padStart(10)}   ${String(pct).padStart(3)}%`);
    }
  }

  console.log('\nIN PLAIN ENGLISH');
  console.log('🧭 This describes what is actually inside the folder.');
  console.log('🤖 Gemma has not been asked yet whether it is cache or not.');
  console.log('🛡️ No file has been deleted or modified.');
  console.log(`\nTrace: ${logger.logFile}`);
}

main().catch((error: unknown) => {
  console.error('[AnSysWarden] Inspection failed:', error);
  process.exitCode = 1;
});
