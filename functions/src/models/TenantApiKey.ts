/**
 * Per-tenant host API key for service-to-service calls.
 *
 * Plaintext secrets are formatted as `ak_live_<random>` and are only ever
 * returned to the caller at creation time. Firestore stores the SHA-256 hash
 * of the secret (`hashedSecret`) along with a short `keyPrefix` (the first
 * 12 characters of the plaintext, e.g. `ak_live_ab12`) so that incoming
 * requests can be looked up cheaply by prefix and then verified with a
 * constant-time hash compare.
 *
 * NOTE: This feature depends on the tenantId data-model foundation
 * (see issue #129 / PR #134). Until that lands, `tenantId` here is a
 * free-form identifier supplied by the admin endpoint and is not yet
 * cross-referenced against a tenants collection.
 */

export type TenantApiKeyScope =
  | 'usage.read'
  | 'tenants.read'
  | 'webhooks.write'
  | 'tenant.admin';

export const TENANT_API_KEY_SCOPES: readonly TenantApiKeyScope[] = [
  'usage.read',
  'tenants.read',
  'webhooks.write',
  /**
   * `tenant.admin` grants destructive offboarding capabilities:
   * exporting all tenant data and irreversibly deleting it
   * (issue #155). It MUST NOT be combined with end-user bearer
   * auth — these endpoints are host-key-only.
   */
  'tenant.admin',
] as const;

export interface TenantApiKeyRecord {
  /** Document id (also returned to the admin). */
  id: string;
  /** Tenant this key is bound to. Cross-tenant calls return 403. */
  tenantId: string;
  /** First 12 chars of the plaintext key, used as a lookup index. */
  keyPrefix: string;
  /** SHA-256 hex digest of the plaintext key. */
  hashedSecret: string;
  /** Granted scopes (subset of TENANT_API_KEY_SCOPES). */
  scopes: TenantApiKeyScope[];
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of last successful authentication, or null. */
  lastUsedAt: string | null;
  /** ISO-8601 timestamp of revocation, or null if active. */
  revokedAt: string | null;
  /** Optional human-readable label for the key. */
  label?: string;
}

export const TENANT_API_KEYS_COLLECTION = 'tenantApiKeys';
export const TENANT_API_KEY_PREFIX = 'ak_live_';
/** Length (in chars) of the prefix used as a Firestore lookup index. */
export const TENANT_API_KEY_PREFIX_INDEX_LENGTH = 12;
