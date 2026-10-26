import { installDust } from './dust-installer';
import { DustScanner } from './dust-scanner';

function usage(): never {
  console.log('Usage:');
  console.log('  ./ansys dust install');
  console.log('  ./ansys dust status');
  console.log('  ./ansys dust scan <path> [--depth N] [--min-size SIZE] [--ai-depth N] [--ai-max-entries N]');
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readIntegerOption(args: string[], name: string): number | undefined {
  const raw = readOption(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid value for ${name}: ${raw}`);
  return value;
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function startScanProgress(): () => void {
  const startedAt = Date.now();
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;

  if (process.stdout.isTTY) {
    const render = (): void => {
      const elapsed = formatElapsed(Date.now() - startedAt);
      const text = `${frames[frame % frames.length]} Scanning with Dust... ${elapsed} · process active`;
      frame += 1;
      process.stdout.write(`\r${text.padEnd(72, ' ')}`);
    };

    render();
    const timer = setInterval(render, 200);
    timer.unref();

    return () => {
      clearInterval(timer);
      const elapsed = formatElapsed(Date.now() - startedAt);
      process.stdout.write(`\r✓ Dust finished; preparing a safe AI tree · ${elapsed}${' '.repeat(18)}\n`);
    };
  }

  console.log('Status:      Scanning with Dust...');
  const timer = setInterval(() => {
    const elapsed = formatElapsed(Date.now() - startedAt);
    console.log(`Progress:    ${elapsed} elapsed · Dust is still running`);
  }, 10_000);
  timer.unref();

  return () => {
    clearInterval(timer);
    const elapsed = formatElapsed(Date.now() - startedAt);
    console.log(`Progress:    Dust finished after ${elapsed}; preparing AI tree`);
  };
}

async function run(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const dust = new DustScanner();

  if (command === 'install') {
    console.log('\nAnSysWarden · Dust Installation');
    console.log('────────────────────────────────────────');
    console.log('Source:     official bootandy/dust release');
    console.log('Target:     local installation managed by AnSysWarden');
    console.log('Security:   mandatory SHA-256 verification');

    const result = await installDust();
    console.log(`Version:      ${result.version}`);
    console.log(`Architecture: ${result.architecture}`);
    console.log(`Binary:       ${result.binPath}`);
    console.log(`SHA-256:      ${result.sha256}`);

    const version = await dust.version();
    console.log(`Verification: ${version}`);
    console.log('Status:       OK');
    return;
  }

  if (command === 'status') {
    const bin = dust.getBinary();
    const version = await dust.version();
    console.log('\nAnSysWarden · Dust');
    console.log('────────────────────────────────────────');
    console.log('Status:  OK');
    console.log(`Version: ${version || '(no version)'}`);
    console.log(`Binary:  ${bin.path}`);
    console.log(`Source:  ${bin.source}`);
    console.log('Mode:    external read-only engine');
    return;
  }

  if (command === 'scan') {
    const inputPath = args[0];
    if (!inputPath || inputPath.startsWith('--')) usage();

    const depth = readIntegerOption(args, '--depth');
    const aiTreeDepth = readIntegerOption(args, '--ai-depth');
    const aiTreeMaxEntries = readIntegerOption(args, '--ai-max-entries');
    const minSize = readOption(args, '--min-size');

    console.log('\nAnSysWarden · Dust Scan');
    console.log('────────────────────────────────────────');
    console.log(`Source:      ${inputPath}`);
    console.log(`Depth:       ${depth === undefined ? 'default' : String(depth)}`);
    console.log(`Min size:    ${minSize ?? 'default'}`);
    console.log(`AI tree:     depth ${aiTreeDepth ?? 6} · max ${aiTreeMaxEntries ?? 2000} visible entries`);
    console.log('Progress:    live elapsed time; Dust does not expose a reliable percentage');

    const stopProgress = startScanProgress();
    let result: Awaited<ReturnType<DustScanner['scan']>>;
    try {
      result = await dust.scan(inputPath, { depth, minSize, aiTreeDepth, aiTreeMaxEntries });
    } finally {
      stopProgress();
    }

    const ecosystems = result.aiInput.summary.ecosystems.length > 0
      ? result.aiInput.summary.ecosystems.join(', ')
      : '(none detected)';
    const languages = result.aiInput.summary.languages.length > 0
      ? result.aiInput.summary.languages.join(', ')
      : '(no data)';

    console.log('────────────────────────────────────────');
    console.log(`Scan ID:      ${result.scan.id}`);
    console.log(`Entries:      ${result.scan.entries.length}`);
    console.log(`Depth:        ${result.depth}`);
    console.log(`Min size:     ${result.minSize}`);
    console.log(`Saved:        ${result.filePath}`);
    console.log(`AI tree:      ${result.aiInputPath}`);
    console.log(`  visible:    ${result.aiInput.summary.visibleEntries}`);
    console.log(`  omitted:    ${result.aiInput.summary.omittedEntries}`);
    console.log(`  local:      ${result.aiInput.summary.resolvedLocally}`);
    console.log(`  to Gemma:   ${result.aiInput.summary.aiCandidates}`);
    console.log(`  ecosystems: ${ecosystems}`);
    console.log(`  Enry:       ${result.aiInput.summary.enryAvailable ? 'active' : 'manifest fallback'}`);
    console.log(`  languages:  ${languages}`);
    console.log('Status:       full scan + project context + ai-input.v1 persisted on the PC backend');
    return;
  }

  usage();
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Dust] ${message}`);
  process.exitCode = 1;
});
