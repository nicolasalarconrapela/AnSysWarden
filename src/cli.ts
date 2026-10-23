import { resolve } from 'node:path';
import { PathClassifier } from './ai/classifier';

function usage(): void {
  console.log('Uso: npx tsx src/cli.ts classify <ruta>');
}

function printResult(result: Awaited<ReturnType<PathClassifier['classify']>>): void {
  const confidence = Math.round(result.confidence * 100);
  console.log('\nAnSysWarden');
  console.log('────────────────────────────────────────');
  console.log(`Path:           ${result.path}`);
  console.log(`Classification: ${result.classification}`);
  console.log(`Confidence:     ${confidence}%`);
  console.log(`Source:         ${result.source}`);
  console.log(`Reason:         ${result.reason}`);
  console.log('Action:         No files have been deleted.');
}

async function main(): Promise<void> {
  const [, , command, rawPath] = process.argv;

  if (command !== 'classify' || !rawPath) {
    usage();
    process.exitCode = 1;
    return;
  }

  const classifier = new PathClassifier();
  const result = await classifier.classify(resolve(rawPath));
  printResult(result);
}

main().catch((error: unknown) => {
  console.error('[AnSysWarden] Error:', error);
  process.exitCode = 1;
});
