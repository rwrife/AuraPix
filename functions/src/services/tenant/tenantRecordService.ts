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
  STORAGE_THRESHOLDS_MAX_COUNT,
  STORAGE_THRESHOLD_MAX,
  STORAGE_THRESHOLD_MIN_EXCLUSIVE,
  TENANTS_COLLECTION,
  type StorageThresholdState,
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
  patch: {
    quotaBytes?: number | null;
    storageThresholds?: number[] | null;
    storageThresholdState?: Record<string, StorageThresholdState>;
  }
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
    storageThresholds:
      patch.storageThresholds === undefined
        ? (existing?.storageThresholds ?? null)
        : patch.storageThresholds,
    storageThresholdState:
      patch.storageThresholdState === undefined
        ? (existing?.storageThresholdState ?? {})
        : patch.storageThresholdState,
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

/**
 * Validate / normalize a `storageThresholds` payload submitted via the
 * admin API (issue #196). Returns the normalized, sorted, deduped array
 * or throws with a stable message.
 *
 * Accepts `null` to mean "clear the override and revert to
 * {@link DEFAULT_STORAGE_THRESHOLDS}".
 */
export function validateStorageThresholdsInput(
  value: unknown
): number[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error('storageThresholds must be an array of numbers or null');
  }
  if (value.length === 0) {
    throw new Error('storageThresholds must contain at least one entry');
  }
  if (value.length > STORAGE_THRESHOLDS_MAX_COUNT) {
    throw new Error(
      `storageThresholds may contain at most ${STORAGE_THRESHOLDS_MAX_COUNT} entries`
    );
  }
  const seen = new Set<string>();
  const normalized: number[] = [];
  for (const raw of value) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new Error(
        'storageThresholds entries must be finite numbers'
      );
    }
    if (raw <= STORAGE_THRESHOLD_MIN_EXCLUSIVE) {
      throw new Error(
        `storageThresholds entries must be greater than ${STORAGE_THRESHOLD_MIN_EXCLUSIVE}`
      );
    }
    if (raw > STORAGE_THRESHOLD_MAX) {
      throw new Error(
        `storageThresholds entries must be ≤ ${STORAGE_THRESHOLD_MAX}`
      );
    }
    // Normalize to 3 decimal places to dedupe near-equal values that
    // would otherwise produce duplicate state keys.
    const fixed = Number(raw.toFixed(3));
    const key = fixed.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(fixed);
  }
  normalized.sort((a, b) => a - b);
  return normalized;
}

/** Exposed for tests. */
export const __test = { readDefaultQuotaBytes };
