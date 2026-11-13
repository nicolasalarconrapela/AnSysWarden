import { resolve } from 'node:path';
import { PathClassifier } from '../../../ai/classifier';
import { ScanService } from '../../../application/scan/scan-service';
import type { TraceLogger } from '../../../observability/logger';
import { candidateLabel, formatBytes } from '../../../scanner/scanner';
import { pick } from '../presentation/terminal';
import { renderScan } from '../presentation/scan-presenter';

function parseMinMb(args: string[]): number | undefined {
  const index = args.indexOf('--min-mb');
  if (index === -1) return undefined;

  const raw = args[index + 1];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(pick(`Invalid value for --min-mb: ${String(raw)}`, `Valor inválido para --min-mb: ${String(raw)}`));
  }

  return value;
}

export async function runScanCommand(root: string, args: string[], logger: TraceLogger): Promise<void> {
  const minMb = parseMinMb(args) ?? 50;
  const classifier = new PathClassifier(logger);
  const scanner = new ScanService(classifier, logger);
  const summary = await scanner.scan(root, { minBytes: minMb * 1024 * 1024 });

  renderScan({
    root: resolve(root),
    thresholdMb: minMb,
    candidates: summary.candidates.map((candidate) => ({
      label: candidateLabel(candidate.path),
      path: candidate.path,
      size: formatBytes(candidate.sizeBytes),
      classification: candidate.classification,
      confidence: candidate.confidence,
      source: candidate.source,
      reason: candidate.reason,
    })),
    scannedFiles: summary.scannedFiles,
    scannedDirectories: summary.scannedDirectories,
    skippedEntries: summary.skippedEntries,
    totalMeasured: formatBytes(summary.totalBytes),
    potentiallySafe: formatBytes(summary.recoverableBytes),
    runId: logger.runId,
    logFile: logger.logFile,
  });
}
