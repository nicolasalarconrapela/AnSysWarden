export type Classification = 'SAFE_CACHE' | 'REVIEW_REQUIRED' | 'USER_DATA';

export type ClassificationSource = 'rule' | 'ai' | 'fallback';

export interface ClassificationResult {
  path: string;
  classification: Classification;
  confidence: number;
  reason: string;
  source: ClassificationSource;
}

export interface AiClassificationPayload {
  classification: Classification;
  confidence: number;
  reason: string;
}
