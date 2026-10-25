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
 * Contrato de salida de Gemma.
 *
 * La IA describe evidencia y riesgo, pero NO decide SAFE_CACHE.
 * Solo las reglas locales deterministas de AnSysWarden pueden autorizar
 * una clasificación efectiva SAFE_CACHE.
 */
export interface AiEvidencePayload {
  regenerability: AiRegenerability;
  userDataRisk: AiUserDataRisk;
  confidence: number;
  evidence: string[];
  reason: string;
}
