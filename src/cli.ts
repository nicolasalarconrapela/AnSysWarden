import { TraceLogger } from './observability/logger';
import { t } from './i18n';
import {
  runClassifyCommand,
  runDoctorCommand,
  runSafetyCommand,
  runScanCommand,
} from './interfaces/cli/commands';
import { pick } from './interfaces/cli/presentation/terminal';

function usage(): void {
  console.log(t('common.usage'));
  console.log('  npx tsx src/cli.ts doctor');
  console.log(`  npx tsx src/cli.ts classify <${pick('path', 'ruta')}>`);
  console.log(`  npx tsx src/cli.ts scan <${pick('path', 'ruta')}> [--min-mb N]`);
  console.log('  npx tsx src/cli.ts test safety');
}

async function main(): Promise<void> {
  const [, , command, rawPath, ...rest] = process.argv;
  const logger = new TraceLogger();

  await logger.info('run.start', pick('Run started', 'Ejecución iniciada'), {
    command: command ?? null,
    argv: process.argv.slice(2),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });

  if (command === 'doctor') {
    await runDoctorCommand(logger);
    return;
  }

  if (command === 'classify' && rawPath) {
    await runClassifyCommand(rawPath, logger);
    return;
  }

  if (command === 'scan' && rawPath) {
    await runScanCommand(rawPath, rest, logger);
    return;
  }

  if (command === 'test' && rawPath === 'safety') {
    await runSafetyCommand(logger);
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch(async (error: unknown) => {
  const logger = new TraceLogger();
  const message = error instanceof Error ? error.message : String(error);

  await logger.error(
    'run.fatal',
    pick('Unhandled fatal error', 'Error fatal no controlado'),
    { error: message },
  );

  console.error('[AnSysWarden] Error:', error);
  console.error(`[AnSysWarden] ${t('common.trace')}: ${logger.logFile}`);
  process.exitCode = 1;
});
