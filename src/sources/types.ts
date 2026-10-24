export const SOURCE_CAPTURE_SCHEMA = 'ansyswarden.source-capture.v1' as const;

export type SourceCaptureFormat = 'json' | 'text';

export interface SourceCaptureDocument {
  schema: typeof SOURCE_CAPTURE_SCHEMA;
  id: string;
  source: string;
  capturedAt: string;
  computer: string;
  inputFile: string;
  format: SourceCaptureFormat;
  byteLength: number;
  payload: unknown;
}

export interface SourceInspection {
  source: string;
  inputFile: string;
  format: SourceCaptureFormat;
  byteLength: number;
  topLevel: 'object' | 'array' | 'scalar' | 'text';
  keys: string[];
  itemCount?: number;
}
