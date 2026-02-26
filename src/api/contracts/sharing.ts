import type {
  CreateShareLinkInput,
  ResolveShareLinkInput,
  ShareAccessEvent,
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

export interface RevokeShareLinkRequest {
  linkId: string;
}
