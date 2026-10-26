import { basename, resolve } from 'node:path';
import { resolveLanguage, setLanguage, t } from '../i18n';
import { TraceLogger } from '../observability/logger';
import { formatBytes } from '../scanner/scanner';
import { ArtifactProfiler } from './artifact-profiler';

function formatDate(ms: number | null): string {
  if (ms === null) return 'n/a';
  return new Date(ms).toISOString();
}

function readInput(args: string[]): string | undefined {
  return args.find((arg, index) => arg !== '--lang' && args[index - 1] !== '--lang');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  setLanguage(resolveLanguage(args));

  const input = readInput(args);
  if (!input) {
    console.error(t('inspect.usage'));
    process.exitCode = 1;
    return;
  }

  const logger = new TraceLogger();
  const profiler = new ArtifactProfiler(logger);
  const profile = await profiler.profile(resolve(input));

  console.log(`\n${t('inspect.title')}`);
  console.log('════════════════════════════════════════════════════');
  console.log(`${t('common.name').padEnd(12)} ${basename(profile.path) || profile.path}`);
  console.log(`${t('common.path').padEnd(12)} ${profile.path}`);
  console.log(`${t('common.size').padEnd(12)} ${formatBytes(profile.sizeBytes)}`);
  console.log(`${t('common.files').padEnd(12)} ${profile.fileCount}`);
  console.log(`${t('common.directories').padEnd(12)} ${profile.directoryCount}`);
  console.log(`${t('common.skipped').padEnd(12)} ${profile.skippedEntries}`);
  console.log(`${t('common.oldest').padEnd(12)} ${formatDate(profile.oldestMtimeMs)}`);
  console.log(`${t('common.newest').padEnd(12)} ${formatDate(profile.newestMtimeMs)}`);

  console.log(`\n${t('inspect.file_types')}`);
  console.log('────────────────────────────────────────────────────');
  if (profile.extensions.length === 0) {
    console.log(t('inspect.no_files'));
  } else {
    for (const row of profile.extensions) {
      const pct = profile.sizeBytes > 0 ? Math.round((row.bytes / profile.sizeBytes) * 100) : 0;
      console.log(`${row.extension.padEnd(18)} ${String(row.files).padStart(7)} ${t('common.files').toLowerCase()}   ${formatBytes(row.bytes).padStart(10)}   ${String(pct).padStart(3)}%`);
    }
  }

  console.log(`\n${t('inspect.plain_english')}`);
  console.log(t('inspect.description'));
  console.log(t('inspect.gemma_pending'));
  console.log(t('inspect.no_changes'));
  console.log(`\n${t('common.trace')}: ${logger.logFile}`);
}

main().catch((error: unknown) => {
  console.error(t('inspect.failed'), error);
  process.exitCode = 1;
});
