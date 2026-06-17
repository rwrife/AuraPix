/**
 * Tenant record CRUD on top of {@link DataAdapter}.
 *
 * Tenant records are sparse — most deployments will not have an explicit
 * document per tenant until the host first configures quota for them. The
 * service therefore lazily fills in defaults from the `DEFAULT_TENANT_QUOTA_BYTES`
 * env var (`null` = unlimited).
 */
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import {
  TENANTS_COLLECTION,
  type TenantRecord,
} from '../../models/TenantRecord.js';
import type { TenantId } from '../../domain/tenant/Tenant.js';

function readDefaultQuotaBytes(): number | null {
  const raw = process.env.DEFAULT_TENANT_QUOTA_BYTES?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Fetch a tenant record. Returns a synthesized default (with the env-driven
 * `quotaBytes`) when no document exists yet, so callers never have to
 * special-case "first ever upload for this tenant".
 */
export async function getTenantRecord(
  dataAdapter: DataAdapter,
  tenantId: TenantId
): Promise<TenantRecord> {
  const existing = await dataAdapter.fetchData<TenantRecord>(
    TENANTS_COLLECTION,
    tenantId
  );
  if (existing) {
    return {
      ...existing,
      quotaBytes:
        existing.quotaBytes === undefined ? readDefaultQuotaBytes() : existing.quotaBytes,
    };
  }
  const now = new Date().toISOString();
  return {
    id: tenantId,
    quotaBytes: readDefaultQuotaBytes(),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Upsert the tenant record, persisting the supplied patch. Returns the
 * resulting full record.
 */
export async function patchTenantRecord(
  dataAdapter: DataAdapter,
  tenantId: TenantId,
  patch: { quotaBytes?: number | null }
): Promise<TenantRecord> {
  const existing = await dataAdapter.fetchData<TenantRecord>(
    TENANTS_COLLECTION,
    tenantId
  );
  const now = new Date().toISOString();
  const next: TenantRecord = {
    id: tenantId,
    quotaBytes:
      patch.quotaBytes === undefined
        ? (existing?.quotaBytes ?? readDefaultQuotaBytes())
        : patch.quotaBytes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await dataAdapter.storeData(TENANTS_COLLECTION, tenantId, next);
  return next;
}

/**
 * Validate / coerce a `quotaBytes` value submitted via the admin API.
 * Returns the normalized number / `null`, or throws with a stable message.
 */
export function validateQuotaBytesInput(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('quotaBytes must be a non-negative finite number or null');
  }
  return Math.floor(value);
}

/** Exposed for tests. */
export const __test = { readDefaultQuotaBytes };
