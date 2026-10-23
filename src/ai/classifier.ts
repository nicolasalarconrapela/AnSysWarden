import { OllamaClient } from './ollama-client';
import { classifyByRules } from './rules';
import type { ClassificationResult } from './types';
import { TraceLogger } from '../observability/logger';

export class PathClassifier {
  constructor(
    private readonly logger = new TraceLogger(),
    private readonly ollama = new OllamaClient(undefined, undefined, logger),
  ) {}

  async classify(inputPath: string): Promise<ClassificationResult> {
    await this.logger.info('classifier.start', 'Clasificando ruta', { input_path: inputPath });

    const ruleResult = classifyByRules(inputPath);
    if (ruleResult) {
      await this.logger.info('classifier.rule_match', 'Clasificación resuelta por regla local', {
        input_path: inputPath,
        classification: ruleResult.classification,
        confidence: ruleResult.confidence,
        reason: ruleResult.reason,
      });
      return ruleResult;
    }

    await this.logger.info('classifier.ai_required', 'Ruta ambigua: se requiere Gemma', {
      input_path: inputPath,
      model: this.ollama.getModel(),
    });

    try {
      const ai = await this.ollama.classifyPath(inputPath);

      if (ai.classification === 'SAFE_CACHE') {
        const downgraded: ClassificationResult = {
          path: inputPath,
          classification: 'REVIEW_REQUIRED',
          confidence: 0,
          reason: `Gemma propuso SAFE_CACHE, pero la política de seguridad exige una regla local explícita para autorizarlo. Motivo del modelo: ${ai.reason}`,
          source: 'fallback',
        };

        await this.logger.warn('classifier.ai_safe_cache_blocked', 'SAFE_CACHE propuesto por IA bloqueado por política', {
          input_path: inputPath,
          model: this.ollama.getModel(),
          ai_confidence: ai.confidence,
          ai_reason: ai.reason,
          effective_classification: downgraded.classification,
        });

        return downgraded;
      }

      const result: ClassificationResult = {
        path: inputPath,
        classification: ai.classification,
        confidence: ai.confidence,
        reason: ai.reason,
        source: 'ai',
      };

      await this.logger.info('classifier.success', 'Clasificación completada', {
        input_path: inputPath,
        source: result.source,
        classification: result.classification,
        confidence: result.confidence,
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback: ClassificationResult = {
        path: inputPath,
        classification: 'REVIEW_REQUIRED',
        confidence: 0,
        reason: `No se pudo validar la clasificación de la IA: ${message}`,
        source: 'fallback',
      };

      await this.logger.warn('classifier.fallback', 'Se aplica fallback seguro REVIEW_REQUIRED', {
        input_path: inputPath,
        error: message,
      });

      return fallback;
    }
  }
}
