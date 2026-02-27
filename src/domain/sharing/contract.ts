import type {
  CreateShareLinkInput,
  ResolveShareDownloadInput,
  ResolveShareLinkInput,
  UpdateShareLinkPolicyInput,
  ShareAccessEvent,
  ShareDownloadResolution,
  ShareLink,
} from './types';

export interface SharingService {
  createShareLink(input: CreateShareLinkInput): Promise<ShareLink>;
  listShareLinks(resourceId: string): Promise<ShareLink[]>;
  revokeShareLink(linkId: string): Promise<void>;
  updateShareLinkPolicy(input: UpdateShareLinkPolicyInput): Promise<ShareLink>;
  resolveShareLink(input: ResolveShareLinkInput): Promise<ShareLink | null>;
  resolveShareDownload(input: ResolveShareDownloadInput): Promise<ShareDownloadResolution | null>;
  listAccessEvents(resourceId: string): Promise<ShareAccessEvent[]>;
}
