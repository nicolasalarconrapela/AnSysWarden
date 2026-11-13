export type Classification = 'SAFE_CACHE' | 'REVIEW_REQUIRED' | 'USER_DATA';

export type ClassificationSource = 'rule' | 'ai' | 'fallback';

export interface ClassificationResult {
  path: string;
  classification: Classification;
  confidence: number;
  reason: string;
  source: ClassificationSource;
}

export type AiRegenerability = 'likely' | 'unlikely' | 'unknown';
export type AiUserDataRisk = 'low' | 'medium' | 'high' | 'unknown';

/**
 * Evidence contract produced by an AI adapter.
 *
 * AI describes regenerability and user-data risk, but it never owns the
 * authority to grant SAFE_CACHE. Effective SAFE_CACHE decisions remain a
 * deterministic local-core responsibility.
 */
export interface AiEvidencePayload {
  regenerability: AiRegenerability;
  userDataRisk: AiUserDataRisk;
  confidence: number;
  evidence: string[];
  reason: string;
}
