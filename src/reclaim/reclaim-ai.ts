import { OllamaClient } from '../ai/ollama-client';
import type { AiEvidencePayload } from '../core/classification/types';
import type { ScanDocument } from '../backend/types';
import type { ReclaimCandidate, ReclaimReport } from './reclaim-engine';

const RECLAIM_AI_MODEL = process.env.ANSYSWARDEN_RECLAIM_MODEL ?? 'gemma2:2b';
const RECLAIM_AI_TIMEOUT_MS = readPositiveInt(process.env.ANSYSWARDEN_RECLAIM_AI_TIMEOUT_MS, 45_000);
const RECLAIM_AI_WARM