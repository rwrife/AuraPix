/**
 * Tenant membership record. Represents a user provisioned into a tenant by
 * the host. Stored at `tenants/{tenantId}/members/{userId}` so memberships
 * are always partitioned by tenant — a user may belong to multiple tenants
 * but each membership is independent.
 *
 * Roles (intentionally minimal for the initial release; see issue #143):
 *   - `owner`  — full tenant admin (manage users, branding, quotas)
 *   - `editor` — read+write photos/albums
 *   - `viewer` — read-only access
 *
 * Memberships are NEVER stored globally. Cross-tenant lookups return 404
 * (not 403) to avoid leaking the existence of memberships in other tenants.
 */

export type TenantMemberRole = 'owner' | 'editor' | 'viewer';

export const TENANT_MEMBER_ROLES: readonly TenantMemberRole[] = [
  'owner',
  'editor',
  'viewer',
] as const;

export interface TenantMemberRecord {
  /** Document id within the tenant subcollection. Equal to `userId`. */
  userId: string;
  /** Tenant that owns this membership. */
  tenantId: string;
  /** Contact email recorded by the host at invite time. */
  email: string;
  /** Role granted within this tenant. */
  role: TenantMemberRole;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of last `user.active` debounce event, or null. */
  lastActiveAt: string | null;
  /** ISO-8601 revocation timestamp. Set when the membership is removed. */
  revokedAt: string | null;
}

/**
 * Collection name pattern. The membership document path is
 * `tenantMembers/{tenantId}__{userId}` in the flat key/value adapter
 * (LocalJsonData, FirestoreData) — composite ids keep the data partitioned
 * per tenant while remaining easy to query with the existing
 * `queryData({field, ==, value})` interface.
 */
export const TENANT_MEMBERS_COLLECTION = 'tenantMembers';

/**
 * Build the composite document id used to store a membership in the flat
 * key/value adapter. Format: `{tenantId}__{userId}`.
 */
export function tenantMemberDocId(tenantId: string, userId: string): string {
  return `${tenantId}__${userId}`;
}

export function isTenantMemberRole(value: unknown): value is TenantMemberRole {
  return typeof value === 'string' && (TENANT_MEMBER_ROLES as readonly string[]).includes(value);
}
