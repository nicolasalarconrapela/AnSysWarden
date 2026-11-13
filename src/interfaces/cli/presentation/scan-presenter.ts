import { t } from '../../../i18n';
import { pick, section, title } from './terminal';

export interface ScanCandidatePresentation {
  label: string;
  path: string;
  size: string;
  classification: string;
  confidence: number;
  source: string;
  reason: string;
}

export interface ScanSummaryPresentation {
  root: string;
  thresholdMb: number;
  candidates: ScanCandidatePresentation[];
  scannedFiles: number;
  scannedDirectories: number;
  skippedEntries: number;
  totalMeasured: string;
  potentiallySafe: string;
  runId: string;
  logFile: string;
}

export function renderScan(summary: ScanSummaryPresentation): void {
  title(`AnSysWarden ${pick('Scan', 'Escaneo')}`);
  console.log(`${pick('Root', 'Raíz')}:       ${summary.root}`);
  console.log(`${pick('Threshold', 'Umbral')}:  ${summary.thresholdMb} MB`);
  console.log(`${pick('Mode', 'Modo')}:       ${pick('READ ONLY', 'SOLO LECTURA')}`);

  section(pick('Candidates', 'Candidatos'));

  if (summary.candidates.length === 0) {
    console.log(pick('No directories were found above the threshold.', 'No se encontraron directorios por encima del umbral.'));
  } else {
    summary.candidates.forEach((candidate, index) => {
      console.log(`${index + 1}. ${candidate.label}`);
      console.log(`   ${t('common.path')}:           ${candidate.path}`);
      console.log(`   ${t('common.size')}:           ${candidate.size}`);
      console.log(`   ${t('common.classification')}: ${candidate.classification}`);
      console.log(`   ${t('common.confidence')}:     ${Math.round(candidate.confidence * 100)}%`);
      console.log(`   ${t('common.source')}:         ${candidate.source}`);
      console.log(`   ${t('common.reason')}:         ${candidate.reason}`);
      console.log('');
    });
  }

  console.log(pick('Summary', 'Resumen'));
  console.log('────────────────────────────────────────');
  console.log(`${pick('Files scanned', 'Archivos escaneados')}:       ${summary.scannedFiles}`);
  console.log(`${pick('Directories scanned', 'Directorios escaneados')}: ${summary.scannedDirectories}`);
  console.log(`${pick('Skipped entries', 'Entradas omitidas')}:     ${summary.skippedEntries}`);
  console.log(`${pick('Total measured', 'Total medido')}:      ${summary.totalMeasured}`);
  console.log(`${pick('Potentially safe', 'Potencialmente seguro')}:    ${summary.potentiallySafe}`);
  console.log(`${pick('Action', 'Acción')}:              ${pick('No files have been deleted.', 'No se ha borrado ningún archivo.')}`);
  console.log(`Run ID:              ${summary.runId}`);
  console.log(`${t('common.trace')}:                ${summary.logFile}`);
}
