import { OllamaClient } from '../infrastructure/ollama/ollama-client';
import { classifyByRules } from '../core/classification/rules';
import type { AiEvidencePayload, ClassificationResult } from '../core/classification/types';
import { TraceLogger } from '../observability/logger';
import { ArtifactProfiler, type ArtifactProfile } from '../profiler/artifact-profiler';

export class PathClassifier {
  constructor(
    private readonly logger = new TraceLogger(),
    private readonly ollama = new OllamaClient(undefined, undefined, logger),
    private readonly profiler = new ArtifactProfiler(logger),
  ) {}

  async classify(inputPath: string): Promise<ClassificationResult> {
    return this.classifyLocalPath(inputPath);
  }

  async classifyLocalPath(inputPath: string): Promise<ClassificationResult> {
    await this.logger.info('classifier.start', 'Classifying local path', { input_path: inputPath });

    const ruleResult = classifyByRules(inputPath);
    if (ruleResult) {
      await this.logger.info('classifier.rule_match', 'Classification resolved by local rule', {
        input_path: inputPath,
        classification: ruleResult.classification,
        confidence: ruleResult.confidence,
        reason: ruleResult.reason,
      });
      return ruleResult;
    }

    await this.logger.info('classifier.profile_required', 'Ambiguous path: local inspection is required before asking Gemma', {
      input_path: inputPath,
    });

    let profile: ArtifactProfile;
    try {
      profile = await this.profiler.profile(inputPath);
      await this.logger.info('classifier.profile_ready', 'Artifact profile ready for AI analysis', {
        input_path: inputPath,
        size_bytes: profile.sizeBytes,
        file_count: profile.fileCount,
        directory_count: profile.directoryCount,
        skipped_entries: profile.skippedEntries,
        extensions: profile.extensions,
        profile_complete: profile.profileComplete ?? null,
        limit_reason: profile.limitReason ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback: ClassificationResult = {
        path: inputPath,
        classification: 'REVIEW_REQUIRED',
        confidence: 0,
        reason: `The real contents of the path could not be inspected. For safety, Gemma is not queried and human review is required. Detail: ${message}`,
        source: 'fallback',
      };

      await this.logger.warn('classifier.profile_required_but_unavailable', 'Gemma is not queried without a real artifact profile', {
        input_path: inputPath,
        error: message,
        effective_classification: fallback.classification,
      });

      return fallback;
    }

    return this.classifyProfile(profile, { rulesAlreadyChecked: true });
  }

  async classifyProfile(
    profile: ArtifactProfile,
    options: { rulesAlreadyChecked?: boolean } = {},
  ): Promise<ClassificationResult> {
    this.validateProfile(profile);
    const inputPath = profile.path;

    await this.logger.info('classifier.profile_received', 'Classifying received artifact profile', {
      input_path: inputPath,
      size_bytes: profile.sizeBytes,
      file_count: profile.fileCount,
      directory_count: profile.directoryCount,
      skipped_entries: profile.skippedEntries,
      profile_complete: profile.profileComplete ?? null,
      limit_reason: profile.limitReason ?? null,
    });

    if (!options.rulesAlreadyChecked) {
      const ruleResult = classifyByRules(inputPath);
      if (ruleResult) {
        await this.logger.info('classifier.rule_match', 'Classification resolved by local rule on received profile', {
          input_path: inputPath,
          classification: ruleResult.classification,
          confidence: ruleResult.confidence,
          reason: ruleResult.reason,
        });
        return ruleResult;
      }
    }

    await this.logger.info('classifier.ai_required', 'Artifact profile available: Gemma may analyze the evidence', {
      input_path: inputPath,
      model: this.ollama.getModel(),
      profile_complete: profile.profileComplete ?? null,
    });

    try {
      const evidence = await this.ollama.analyzePath(inputPath, undefined, profile);
      return await this.applyAiEvidence(inputPath, evidence);
    } catch (error) {
      return await this.fallbackFromAiError(inputPath, error);
    }
  }

  private validateProfile(profile: ArtifactProfile): void {
    if (typeof profile.path !== 'string' || profile.path.trim().length === 0) {
      throw new Error('Invalid profile: path is empty.');
    }

    const fields = [
      ['sizeBytes', profile.sizeBytes],
      ['fileCount', profile.fileCount],
      ['directoryCount', profile.directoryCount],
      ['skippedEntries', profile.skippedEntries],
    ] as const;

    for (const [name, value] of fields) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid profile: ${name} must be a non-negative number.`);
      }
    }

    if (!Array.isArray(profile.extensions)) {
      throw new Error('Invalid profile: extensions must be an array.');
    }
  }

  async applyAiEvidence(
    inputPath: string,
    ai: AiEvidencePayload,
  ): Promise<ClassificationResult> {
    const evidenceText = ai.evidence.join('; ');

    if (
      ai.userDataRisk === 'high'
      || (ai.regenerability === 'unlikely' && ai.confidence >= 0.7)
    ) {
      const protectedResult: ClassificationResult = {
        path: inputPath,
        classification: 'USER_DATA',
        confidence: ai.confidence,
        reason: `Gemma detected signals of persistent or potentially unique data. Evidence: ${evidenceText}. ${ai.reason}`,
        source: 'ai',
      };

      await this.logger.info('classifier.ai_protect', 'Gemma provided enough evidence to protect the path as USER_DATA', {
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
      reason: `Gemma provided evidence, but it cannot authorize SAFE_CACHE. Regenerability=${ai.regenerability}, user_data_risk=${ai.userDataRisk}. Evidence: ${evidenceText}. ${ai.reason}`,
      source: 'ai',
    };

    await this.logger.info('classifier.ai_review', 'Gemma evidence remains REVIEW_REQUIRED', {
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
      reason: `AI analysis could not be validated: ${message}`,
      source: 'fallback',
    };

    await this.logger.warn('classifier.fallback', 'Applying safe REVIEW_REQUIRED fallback', {
      input_path: inputPath,
      error: message,
    });

    return fallback;
  }
}
