import { basename } from 'node:path';

export {
  ScanService as LocalScanner,
  removeOverlappingSafeCandidates,
  selectRecoverableSafeCandidates,
  type ScanCandidate,
  type ScanOptions,
  type ScanSummary,
} from '../application/scan/scan-service';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];

  for (let index = 0; index < units.length; index += 1) {
    unit = units[index];
    if (value < 1024 || index === units.length - 1) break;
    value /= 1024;
  }

  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

export function candidateLabel(path: string): string {
  return basename(path) || path;
}
