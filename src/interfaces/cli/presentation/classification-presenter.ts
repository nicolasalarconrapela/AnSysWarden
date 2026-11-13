import { t } from '../../../i18n';
import { pick, title } from './terminal';

export interface ClassificationPresentation {
  path: string;
  classification: string;
  confidence: number;
  source: string;
  reason: string;
}

export interface TracePresentation {
  runId: string;
  logFile: string;
}

export function renderClassificationResult(
  result: ClassificationPresentation,
  trace: TracePresentation,
): void {
  const confidence = Math.round(result.confidence * 100);

  title('AnSysWarden');
  console.log(`${t('common.path')}:           ${result.path}`);
  console.log(`${t('common.classification')}: ${result.classification}`);
  console.log(`${t('common.confidence')}:     ${confidence}%`);
  console.log(`${t('common.source')}:         ${result.source}`);
  console.log(`${t('common.reason')}:         ${result.reason}`);
  console.log(`${pick('Action', 'Acción')}:         ${pick('No files have been deleted.', 'No se ha borrado ningún archivo.')}`);
  console.log(`Run ID:         ${trace.runId}`);
  console.log(`${t('common.trace')}:          ${trace.logFile}`);
}
