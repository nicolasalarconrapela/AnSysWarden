import { OllamaClient } from './ollama-client';
import { classifyByRules } from './rules';
import type { AiEvidencePayload, ClassificationResult } from './types';
import { TraceLogger } from '../observability/logger';
import { ArtifactProfiler } from '../profiler/artifact-profiler';

export class PathClassifier {
  constructor(
    private readonly logger = new TraceLogger(),
    private readonly ollama = new OllamaClient(undefined, undefined, logger),
    private readonly profiler = new ArtifactProfiler(logger),
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

    await this.logger.info('classifier.ai_required', 'Ruta ambigua: se requiere análisis de evidencia de Gemma', {
      input_path: inputPath,
      model: this.ollama.getModel(),
    });

    let profile;
    try {
      profile = await this.profiler.profile(inputPath);
      await this.logger.info('classifier.profile_ready', 'Perfil objetivo disponible para la IA', {
        input_path: inputPath,
        size_bytes: profile.sizeBytes,
        file_count: profile.fileCount,
        directory_count: profile.directoryCount,
        skipped_entries: profile.skippedEntries,
        extensions: profile.extensions,
      });
    } catch (error) {
      await this.logger.warn('classifier.profile_unavailable', 'No se pudo generar perfil local; Gemma recibe contexto incompleto', {
        input_path: inputPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const evidence = await this.ollama.analyzePath(inputPath, undefined, profile);
      return await this.applyAiEvidence(inputPath, evidence);
    } catch (error) {
      return await this.fallbackFromAiError(inputPath, error);
    }
  }

  async applyAiEvidence(
    inputPath: string,
    ai: AiEvidencePayload,
  ): Promise<ClassificationResult> {
    const evidenceText = ai.evidence.join('; ');

    // La IA nunca puede autorizar SAFE_CACHE. La única salida de IA que
    // puede elevar protección es USER_DATA cuando detecta riesgo alto o
    // regenerabilidad improbable con suficiente confianza.
    if (
      ai.userDataRisk === 'high'
      || (ai.regenerability === 'unlikely' && ai.confidence >= 0.7)
    ) {
      const protectedResult: ClassificationResult = {
        path: inputPath,
        classification: 'USER_DATA',
        confidence: ai.confidence,
        reason: `Gemma detectó señales de datos persistentes o potencialmente únicos. Evidencia: ${evidenceText}. ${ai.reason}`,
        source: 'ai',
      };

      await this.logger.info('classifier.ai_protect', 'Gemma aporta evidencia suficiente para proteger como USER_DATA', {
        input_path: inputPath,
        model: this.ollama.getModel(),
        regenerability: ai.regenerability,
        user_data_risk: ai.userDataRisk,
        confidence: ai.confidence,
        evidence: ai.evidence,
      });

      return protectedResult;
    }

    const reviewResult: ClassificationResult = {
      path: inputPath,
      classification: 'REVIEW_REQUIRED',
      confidence: ai.confidence,
      reason: `Gemma aporta evidencia, pero no puede autorizar SAFE_CACHE. Regenerabilidad=${ai.regenerability}, riesgo_datos=${ai.userDataRisk}. Evidencia: ${evidenceText}. ${ai.reason}`,
      source: 'ai',
    };

    await this.logger.info('classifier.ai_review', 'La evidencia de Gemma se mantiene en REVIEW_REQUIRED', {
      input_path: inputPath,
      model: this.ollama.getModel(),
      regenerability: ai.regenerability,
      user_data_risk: ai.userDataRisk,
      confidence: ai.confidence,
      evidence: ai.evidence,
      effective_classification: reviewResult.classification,
    });

    return reviewResult;
  }

  async fallbackFromAiError(inputPath: string, error: unknown): Promise<ClassificationResult> {
    const message = error instanceof Error ? error.message : String(error);
    const fallback: ClassificationResult = {
      path: inputPath,
      classification: 'REVIEW_REQUIRED',
      confidence: 0,
      reason: `No se pudo validar el análisis de la IA: ${message}`,
      source: 'fallback',
    };

    await this.logger.warn('classifier.fallback', 'Se aplica fallback seguro REVIEW_REQUIRED', {
      input_path: inputPath,
      error: message,
    });

    return fallback;
  }
}
