import { OllamaClient } from './ollama-client';
import { classifyByRules } from './rules';
import type { ClassificationResult } from './types';

export class PathClassifier {
  constructor(private readonly ollama = new OllamaClient()) {}

  async classify(inputPath: string): Promise<ClassificationResult> {
    const ruleResult = classifyByRules(inputPath);
    if (ruleResult) {
      return ruleResult;
    }

    try {
      const ai = await this.ollama.classifyPath(inputPath);
      return {
        path: inputPath,
        classification: ai.classification,
        confidence: ai.confidence,
        reason: ai.reason,
        source: 'ai',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        path: inputPath,
        classification: 'REVIEW_REQUIRED',
        confidence: 0,
        reason: `No se pudo validar la clasificación de la IA: ${message}`,
        source: 'fallback',
      };
    }
  }
}
