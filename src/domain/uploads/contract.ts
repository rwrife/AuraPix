import type {
  CreateUploadSessionInput,
  DerivativeJobEnvelope,
  FinalizeUploadInput,
  UploadMetadata,
  UploadSession,
} from './types';

export interface FinalizeUploadResult {
  metadata: UploadMetadata;
  job: DerivativeJobEnvelope;
  idempotentReplay: boolean;
}

export interface UploadSessionsService {
  createUploadSession(input: CreateUploadSessionInput): Promise<UploadSession>;
  finalizeUpload(input: FinalizeUploadInput): Promise<FinalizeUploadResult>;
  listUploadedMetadata(): Promise<UploadMetadata[]>;
  listDerivativeJobs(): Promise<DerivativeJobEnvelope[]>;
  processNextDerivativeJob(): Promise<DerivativeJobEnvelope | null>;
}
