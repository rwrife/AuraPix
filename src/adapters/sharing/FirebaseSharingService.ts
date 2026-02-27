import type { SharingService } from '../../domain/sharing/contract';
import type {
  CreateShareLinkInput,
  ResolveShareDownloadInput,
  ResolveShareLinkInput,
  ShareAccessEvent,
  ShareDownloadResolution,
  ShareLink,
} from '../../domain/sharing/types';

/**
 * Firebase implementation of SharingService (stub for now).
 * Sharing functionality will be implemented in a future phase.
 */
export class FirebaseSharingService implements SharingService {
  constructor() {
    // Stub implementation
  }

  // All methods throw "not implemented" for now
  // This allows the app to run while sharing features are developed

  async createShareLink(_input: CreateShareLinkInput): Promise<ShareLink> {
    throw new Error('Sharing not yet implemented');
  }

  async listShareLinks(_resourceId: string): Promise<ShareLink[]> {
    throw new Error('Sharing not yet implemented');
  }

  async revokeShareLink(_linkId: string): Promise<void> {
    throw new Error('Sharing not yet implemented');
  }

  async resolveShareLink(_input: ResolveShareLinkInput): Promise<ShareLink | null> {
    throw new Error('Sharing not yet implemented');
  }

  async resolveShareDownload(_input: ResolveShareDownloadInput): Promise<ShareDownloadResolution | null> {
    throw new Error('Sharing not yet implemented');
  }

  async listAccessEvents(_resourceId: string): Promise<ShareAccessEvent[]> {
    throw new Error('Sharing not yet implemented');
  }
}
