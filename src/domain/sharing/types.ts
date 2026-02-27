export type SharePermission = 'view' | 'download' | 'collaborate';
export type ShareDownloadPolicy = 'none' | 'derivative_only' | 'original_and_derivative';

export interface SharePolicy {
  permission: SharePermission;
  expiresAt: string | null;
  passwordProtected: boolean;
  maxUses: number | null;
  downloadPolicy: ShareDownloadPolicy;
  watermarkEnabled: boolean;
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

export interface UpdateShareLinkPolicyInput {
  linkId: string;
  policy: Partial<SharePolicy>;
}

export interface ResolveShareDownloadInput extends ResolveShareLinkInput {
  assetKind: 'original' | 'derivative';
}

export interface ShareDownloadResolution {
  link: ShareLink;
  assetKind: ResolveShareDownloadInput['assetKind'];
  watermarkApplied: boolean;
}

export type ShareAccessOutcome =
  | 'granted'
  | 'granted_download'
  | 'denied_not_found'
  | 'denied_revoked'
  | 'denied_expired'
  | 'denied_max_uses'
  | 'denied_invalid_password'
  | 'denied_download_disallowed';

export interface ShareAccessEvent {
  id: string;
  linkId: string | null;
  token: string;
  outcome: ShareAccessOutcome;
  occurredAt: string;
}
