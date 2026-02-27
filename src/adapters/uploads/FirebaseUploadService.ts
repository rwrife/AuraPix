import type { UploadSessionsService, FinalizeUploadResult } from '../../domain/uploads/contract';
import type {
  CreateUploadSessionInput,
  DerivativeJobEnvelope,
  FinalizeUploadInput,
  UploadMetadata,
  UploadSession,
} from '../../domain/uploads/types';

/**
 * Firebase implementation of UploadSessionsService (stub for now).
 * Upload session management will be implemented in a future phase.
 * For now, uploads go directly through LibraryService.addPhoto().
 */
export class FirebaseUploadService implements UploadSessionsService {
  constructor() {
    // Stub implementation
  }

  // All methods throw "not implemented" for now
  // This allows the app to run while upload session features are developed

  async createUploadSession(_input: CreateUploadSessionInput): Promise<UploadSession> {
    throw new Error('Upload sessions not yet implemented. Use LibraryService.addPhoto() for direct uploads.');
  }

  async finalizeUpload(_input: FinalizeUploadInput): Promise<FinalizeUploadResult> {
    throw new Error('Upload sessions not yet implemented. Use LibraryService.addPhoto() for direct uploads.');
  }

  async listUploadedMetadata(): Promise<UploadMetadata[]> {
    throw new Error('Upload sessions not yet implemented. Use LibraryService.addPhoto() for direct uploads.');
  }

  async listDerivativeJobs(): Promise<DerivativeJobEnvelope[]> {
    throw new Error('Upload sessions not yet implemented. Use LibraryService.addPhoto() for direct uploads.');
  }

  async processNextDerivativeJob(): Promise<DerivativeJobEnvelope | null> {
    throw new Error('Upload sessions not yet implemented. Use LibraryService.addPhoto() for direct uploads.');
  }
}