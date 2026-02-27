import type { SharingService } from '../../domain/sharing/contract';
import type {
  CreateShareLinkInput,
  ResolveShareDownloadInput,
  ResolveShareLinkInput,
  UpdateShareLinkPolicyInput,
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

  async createShareLink(input: CreateShareLinkInput): Promise<ShareLink> {
    void input;
    throw new Error('Sharing not yet implemented');
  }

  async listShareLinks(resourceId: string): Promise<ShareLink[]> {
    void resourceId;
    throw new Error('Sharing not yet implemented');
  }

  async revokeShareLink(linkId: string): Promise<void> {
    void linkId;
    throw new Error('Sharing not yet implemented');
  }

  async updateShareLinkPolicy(input: UpdateShareLinkPolicyInput): Promise<ShareLink> {
    void input;
    throw new Error('Sharing not yet implemented');
  }

  async resolveShareLink(input: ResolveShareLinkInput): Promise<ShareLink | null> {
    void input;
    throw new Error('Sharing not yet implemented');
  }

  async resolveShareDownload(input: ResolveShareDownloadInput): Promise<ShareDownloadResolution | null> {
    void input;
    throw new Error('Sharing not yet implemented');
  }

  async listAccessEvents(resourceId: string): Promise<ShareAccessEvent[]> {
    void resourceId;
    throw new Error('Sharing not yet implemented');
  }
}
