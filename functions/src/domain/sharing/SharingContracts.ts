export interface ShareGrant {
  albumId: string;
  token: string;
  expiresAt?: string;
}

export interface SharePolicyRepository {
  findByToken(token: string): Promise<ShareGrant | null>;
}
