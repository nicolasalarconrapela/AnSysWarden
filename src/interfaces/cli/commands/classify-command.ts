import { resolve } from 'node:path';
import { PathClassifier } from '../../../ai/classifier';
import type { TraceLogger } from '../../../observability/logger';
import { renderClassificationResult } from '../presentation/classification-presenter';

export async function runClassifyCommand(rawPath: string, logger: TraceLogger): Promise<void> {
  const classifier = new PathClassifier(logger);
  const result = await classifier.classify(resolve(rawPath));

  renderClassificationResult(
    {
      path: result.path,
      classification: result.classification,
      confidence: result.confidence,
      source: result.source,
      reason: result.reason,
    },
    {
      runId: logger.runId,
      logFile: logger.logFile,
    },
  );
}
