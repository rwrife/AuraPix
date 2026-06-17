/**
 * Tenant membership service. CRUD over `tenants/{tenantId}/members/{userId}`
 * with the flat key/value DataAdapter, plus a simple in-memory debounce for
 * the per-day `user.active` metering signal.
 *
 * Storage: composite document id `{tenantId}__{userId}` in the
 * `tenantMembers` collection (see TenantMember.ts).
 *
 * Per-tenant scoping: every read/list filters by `tenantId` AND
 * `revokedAt == null`. Callers asking for a membership in a tenant they
 * don't own get `null` (the route layer translates this to 404, not 403,
 * so existence of memberships in other tenants is never leaked).
 */
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import {
  TENANT_MEMBERS_COLLECTION,
  tenantMemberDocId,
  type TenantMemberRecord,
  type TenantMemberRole,
} from '../../models/TenantMember.js';

export interface CreateMembershipInput {
  tenantId: string;
  userId: string;
  email: string;
  role: TenantMemberRole;
}

export interface UpdateMembershipInput {
  role?: TenantMemberRole;
}

/**
 * Returns the active (non-revoked) membership for a user in a tenant, or
 * `null` if none exists. Revoked memberships are filtered out so the audit
 * row remains for billing reconciliation but is invisible to callers.
 */
export async function getMembership(
  adapter: DataAdapter,
  tenantId: string,
  userId: string
): Promise<TenantMemberRecord | null> {
  const doc = await adapter.fetchData<TenantMemberRecord>(
    TENANT_MEMBERS_COLLECTION,
    tenantMemberDocId(tenantId, userId)
  );
  if (!doc) return null;
  if (doc.tenantId !== tenantId) return null;
  if (doc.revokedAt) return null;
  return doc;
}

/**
 * Creates a new tenant membership. Returns the existing active membership
 * unchanged if one already exists for the given (tenantId, userId), so the
 * caller can treat the POST as idempotent at the storage layer.
 */
export async function createMembership(
  adapter: DataAdapter,
  input: CreateMembershipInput
): Promise<{ record: TenantMemberRecord; created: boolean }> {
  const existing = await getMembership(adapter, input.tenantId, input.userId);
  if (existing) return { record: existing, created: false };

  const record: TenantMemberRecord = {
    userId: input.userId,
    tenantId: input.tenantId,
    email: input.email,
    role: input.role,
    createdAt: new Date().toISOString(),
    lastActiveAt: null,
    revokedAt: null,
  };
  await adapter.storeData(
    TENANT_MEMBERS_COLLECTION,
    tenantMemberDocId(input.tenantId, input.userId),
    record
  );
  return { record, created: true };
}

export async function listMemberships(
  adapter: DataAdapter,
  tenantId: string
): Promise<TenantMemberRecord[]> {
  const all = await adapter.queryData<TenantMemberRecord>(
    TENANT_MEMBERS_COLLECTION,
    [{ field: 'tenantId', operator: '==', value: tenantId }]
  );
  return all
    .filter((m) => !m.revokedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function updateMembership(
  adapter: DataAdapter,
  tenantId: string,
  userId: string,
  updates: UpdateMembershipInput
): Promise<TenantMemberRecord | null> {
  const existing = await getMembership(adapter, tenantId, userId);
  if (!existing) return null;
  const patch: Partial<TenantMemberRecord> = {};
  if (updates.role) patch.role = updates.role;
  if (Object.keys(patch).length === 0) return existing;
  await adapter.updateData<TenantMemberRecord>(
    TENANT_MEMBERS_COLLECTION,
    tenantMemberDocId(tenantId, userId),
    patch
  );
  return { ...existing, ...patch };
}

/**
 * Soft-revoke a membership: stamp `revokedAt` but keep the row so audit /
 * billing reconciliation can see who was a member and when.
 */
export async function revokeMembership(
  adapter: DataAdapter,
  tenantId: string,
  userId: string
): Promise<TenantMemberRecord | null> {
  const existing = await getMembership(adapter, tenantId, userId);
  if (!existing) return null;
  const revokedAt = new Date().toISOString();
  await adapter.updateData<TenantMemberRecord>(
    TENANT_MEMBERS_COLLECTION,
    tenantMemberDocId(tenantId, userId),
    { revokedAt }
  );
  return { ...existing, revokedAt };
}

/**
 * Touch `lastActiveAt` for the membership. Best-effort and silently swallows
 * errors so an activity ping never breaks the request path.
 */
export async function touchLastActive(
  adapter: DataAdapter,
  tenantId: string,
  userId: string,
  whenIso: string
): Promise<void> {
  try {
    await adapter.updateData<TenantMemberRecord>(
      TENANT_MEMBERS_COLLECTION,
      tenantMemberDocId(tenantId, userId),
      { lastActiveAt: whenIso }
    );
  } catch {
    // ignore — touch is best-effort
  }
}

/**
 * Per-(tenantId, userId) UTC-day debounce for the `user.active` metering
 * signal. Keeps an in-memory set keyed by `{tenantId}|{userId}|{YYYY-MM-DD}`.
 * Suitable for a single-process deployment; a multi-process rollout will
 * swap this for a shared store but the public API stays the same.
 */
export class UserActiveDebouncer {
  private readonly seen = new Set<string>();

  /**
   * Returns true if this is the first activity for (tenantId, userId) on the
   * UTC date derived from `whenIso`. The caller should emit `user.active`
   * only when this returns true.
   */
  shouldEmit(tenantId: string, userId: string, whenIso: string): boolean {
    const day = whenIso.slice(0, 10); // YYYY-MM-DD
    const key = `${tenantId}|${userId}|${day}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  /** Test/observability helper. */
  size(): number {
    return this.seen.size;
  }

  /** Test helper — drop all debounce state. */
  reset(): void {
    this.seen.clear();
  }
}
