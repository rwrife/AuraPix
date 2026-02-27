import type {
  CreateShareLinkInput,
  ResolveShareDownloadInput,
  ResolveShareLinkInput,
  UpdateShareLinkPolicyInput,
  ShareAccessEvent,
  ShareDownloadResolution,
  ShareLink,
} from '../../domain/sharing/types';

// ---------------------------------------------------------------------------
// Sharing API contracts
// ---------------------------------------------------------------------------

export type CreateShareLinkRequest = CreateShareLinkInput;
export interface CreateShareLinkResponse {
  link: ShareLink;
}

export interface ListShareLinksResponse {
  links: ShareLink[];
}

export interface ListShareAccessEventsResponse {
  events: ShareAccessEvent[];
}

export type ResolveShareLinkRequest = ResolveShareLinkInput;
export interface ResolveShareLinkResponse {
  link: ShareLink | null;
}

export type ResolveShareDownloadRequest = ResolveShareDownloadInput;
export interface ResolveShareDownloadResponse {
  resolution: ShareDownloadResolution | null;
}

export interface RevokeShareLinkRequest {
  linkId: string;
}

export type UpdateShareLinkPolicyRequest = UpdateShareLinkPolicyInput;
export interface UpdateShareLinkPolicyResponse {
  link: ShareLink;
}
