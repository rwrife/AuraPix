import type { CreateShareLinkInput, ResolveShareLinkInput, ShareLink } from './types';

export interface SharingService {
  createShareLink(input: CreateShareLinkInput): Promise<ShareLink>;
  listShareLinks(resourceId: string): Promise<ShareLink[]>;
  revokeShareLink(linkId: string): Promise<void>;
  resolveShareLink(input: ResolveShareLinkInput): Promise<ShareLink | null>;
}
