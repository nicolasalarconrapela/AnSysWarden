import { OllamaClient } from '../../../ai/ollama-client';
import type { TraceLogger } from '../../../observability/logger';
import { t } from '../../../i18n';
import { pick, title } from '../presentation/terminal';

export async function runDoctorCommand(logger: TraceLogger): Promise<void> {
  const ollama = new OllamaClient(undefined, undefined, logger);

  title(`AnSysWarden ${pick('Doctor', 'Diagnóstico')}`);
  console.log(`Ollama host: ${ollama.getHost()}`);
  console.log(`${t('common.model')}:       ${ollama.getModel()}`);

  try {
    const status = await logger.span(
      'doctor.ollama',
      pick('Checking local Ollama', 'Comprobando Ollama local'),
      () => ollama.health(),
      { host: ollama.getHost(), model: ollama.getModel() },
    );

    console.log('Status:      OK');
    console.log(`${pick('Models', 'Modelos')}:      ${status.models.length ? status.models.join(', ') : pick('(none)', '(ninguno)')}`);
    console.log(`Run ID:      ${logger.runId}`);
    console.log(`${t('common.trace')}:       ${logger.logFile}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Status:      ERROR');
    console.error(`${pick('Detail', 'Detalle')}:      ${message}`);
    console.error(`Run ID:      ${logger.runId}`);
    console.error(`${t('common.trace')}:       ${logger.logFile}`);
    process.exitCode = 1;
  }
}
