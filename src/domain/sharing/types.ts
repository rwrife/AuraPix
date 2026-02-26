export type SharePermission = 'view' | 'download' | 'collaborate';

export interface SharePolicy {
  permission: SharePermission;
  expiresAt: string | null;
  passwordProtected: boolean;
  maxUses: number | null;
}

export interface ShareLink {
  id: string;
  token: string;
  resourceType: 'album' | 'photo' | 'library';
  resourceId: string;
  policy: SharePolicy;
  useCount: number;
  revoked: boolean;
  createdAt: string;
  createdBy: string;
}

export interface CreateShareLinkInput {
  resourceType: ShareLink['resourceType'];
  resourceId: string;
  policy: Partial<SharePolicy>;
  password?: string;
}

export interface ResolveShareLinkInput {
  token: string;
  password?: string;
}

export type ShareAccessOutcome =
  | 'granted'
  | 'denied_not_found'
  | 'denied_revoked'
  | 'denied_expired'
  | 'denied_max_uses'
  | 'denied_invalid_password';

export interface ShareAccessEvent {
  id: string;
  linkId: string | null;
  token: string;
  outcome: ShareAccessOutcome;
  occurredAt: string;
}
