export type UploadProcessingState = 'pending_processing' | 'completed';

export interface UploadSession {
  sessionId: string;
  idempotencyKey: string;
  objectKey: string;
  uploadUrl: string;
  expiresAt: string;
}

export interface UploadMetadata {
  uploadId: string;
  fileName: string;
  objectKey: string;
  sourcePointer: string;
  byteSize: number;
  processingState: UploadProcessingState;
  derivativeJobId: string;
}

export interface DerivativeJobEnvelope {
  jobId: string;
  idempotencyKey: string;
  metadataUploadId: string;
  objectKey: string;
  status: 'queued' | 'running' | 'completed';
  createdAt: string;
}

export interface CreateUploadSessionInput {
  fileName: string;
  /**
   * Optional client request identifier for retry-safe session creation.
   * Reusing the same value with the same file name returns the original session.
   */
  clientRequestId?: string;
}

export interface FinalizeUploadInput {
  sessionId: string;
  fileName: string;
  byteSize: number;
  idempotencyKey: string;
}
