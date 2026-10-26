import { OllamaClient } from '../../../ai/ollama-client';
import type { TraceLogger } from '../../../observability/logger';
import { runAiSafetySuite } from '../../../tests/ai-safety';
import {
  renderSafetyHeader,
  renderSafetyPrecheck,
  renderSafetyPrecheckModelMissing,
  renderSafetyPrecheckReady,
  renderSafetyPrecheckUnavailable,
  renderSafetyResult,
} from '../presentation/safety-presenter';
import { pick } from '../presentation/terminal';

async function ensureSafetyAiReady(logger: TraceLogger): Promise<boolean> {
  const ollama = new OllamaClient(undefined, undefined, logger);
  renderSafetyPrecheck(ollama.getHost(), ollama.getModel());

  try {
    const status = await ollama.health();
    const modelPresent = status.models.some((name) => name.startsWith(ollama.getModel()));

    if (!modelPresent) {
      renderSafetyPrecheckModelMissing(status.models);
      await logger.error(
        'safety.precheck.model_missing',
        pick('Required model unavailable for the safety suite', 'Modelo requerido no disponible para la batería de seguridad'),
        {
          model: ollama.getModel(),
          models: status.models,
        },
      );
      process.exitCode = 3;
      return false;
    }

    renderSafetyPrecheckReady();
    await logger.info(
      'safety.precheck.ok',
      pick('AI precheck passed', 'Precheck de IA correcto'),
      {
        model: ollama.getModel(),
        models: status.models,
      },
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderSafetyPrecheckUnavailable(message);
    await logger.error(
      'safety.precheck.ollama_unavailable',
      pick('Ollama unavailable before the safety suite', 'Ollama no disponible antes de la batería de seguridad'),
      {
        error: message,
        host: ollama.getHost(),
        model: ollama.getModel(),
      },
    );
    process.exitCode = 3;
    return false;
  }
}

export async function runSafetyCommand(logger: TraceLogger): Promise<void> {
  renderSafetyHeader();

  if (!(await ensureSafetyAiReady(logger))) return;

  const result = await runAiSafetySuite(logger);
  renderSafetyResult(result, logger.logFile);

  if (result.systemFailed > 0) process.exitCode = 2;
}
