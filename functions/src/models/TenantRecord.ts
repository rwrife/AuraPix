/**
 * Per-tenant configuration document.
 *
 * A `TenantRecord` is the canonical, mutable description of a tenant —
 * everything billing / quota / branding related that the host application
 * needs to look up by `tenantId`. It is intentionally narrow today
 * (quota only) and will accumulate fields over time.
 *
 * Storage: Firestore collection `tenants/{tenantId}` (and the LocalJsonData
 * equivalent in local dev mode).
 *
 * Quota semantics:
 *  - `quotaBytes = null` means "unlimited" (no enforcement).
 *  - `quotaBytes = 0` means "no uploads allowed".
 *  - `quotaBytes > 0` enforces `currentUsageBytes + incomingSizeBytes <= quotaBytes`.
 *
 * See `docs/features/usage-and-billing.md` and the upload handler in
 * `handlers/images/upload.ts` for enforcement details.
 */

import type { TenantId } from '../domain/tenant/Tenant.js';

export const TENANTS_COLLECTION = 'tenants';

/**
 * Default storage-usage thresholds (issue #196). Each value is a
 * fraction of `quotaBytes`; a value > 1.0 is permitted for overage
 * alerting (e.g. host wants to know when a tenant is 5% over).
 *
 * These defaults apply when a tenant has no explicit override on its
 * record. Order matches the public docs and the
 * `tenant.storage.threshold_crossed` event ordering.
 */
export const DEFAULT_STORAGE_THRESHOLDS: readonly number[] = [
  0.5,
  0.8,
  0.95,
  1.0,
];

/** Max number of per-tenant thresholds accepted by the admin API. */
export const STORAGE_THRESHOLDS_MAX_COUNT = 8;
/** Max allowed threshold value (overage alerting). */
export const STORAGE_THRESHOLD_MAX = 1.5;
/** Min allowed threshold value (exclusive lower bound). */
export const STORAGE_THRESHOLD_MIN_EXCLUSIVE = 0;
/**
 * Hysteresis band (fraction of quota) — a threshold does not re-fire
 * `crossed` until usage has dropped by at least this much below it and
 * then crossed up again. Keeps webhook traffic quiet when usage hovers
 * right around a threshold.
 */
export const STORAGE_THRESHOLD_HYSTERESIS = 0.05;

/**
 * Per-threshold crossing state (issue #196).
 *
 * Stored on the tenant doc so the evaluator can decide whether the
 * tenant has crossed a given threshold for the first time, is still in
 * the crossed band (no event), or has cleared (after hysteresis).
 *
 * `crossed` is the source of truth for whether `_crossed` has already
 * fired since the last `_cleared` (or since the tenant was created).
 * `lastCrossedAt` / `lastClearedAt` are observability fields.
 */
export interface StorageThresholdState {
  /**
   * Currently in the "crossed" half of the hysteresis loop. While true,
   * `_crossed` will NOT fire again for this threshold; it can only flip
   * back to false after a `_cleared` event.
   */
  crossed: boolean;
  /** ISO-8601 timestamp of the most recent `_crossed` emission. */
  lastCrossedAt?: string;
  /** ISO-8601 timestamp of the most recent `_cleared` emission. */
  lastClearedAt?: string;
}

export interface TenantRecord {
  /** Document id (same as the resolved `TenantId`). */
  id: TenantId;
  /**
   * Per-tenant storage cap in bytes. `null` (or missing) means unlimited
   * for this tenant; the system-wide default from
   * `DEFAULT_TENANT_QUOTA_BYTES` is applied at read time when the record
   * itself omits a value.
   */
  quotaBytes: number | null;
  /**
   * Per-tenant storage thresholds (issue #196). `null` / `undefined`
   * means "use {@link DEFAULT_STORAGE_THRESHOLDS}". Each value is a
   * fraction of `quotaBytes` in the open interval
   * `(0, STORAGE_THRESHOLD_MAX]`. Max length is
   * {@link STORAGE_THRESHOLDS_MAX_COUNT}. Order is not significant; the
   * evaluator always sorts ascending.
   */
  storageThresholds?: number[] | null;
  /**
   * Per-threshold crossing state (issue #196). Keyed by the threshold's
   * fixed-precision string form (see `thresholdStateKey()`). Missing
   * entries are treated as `{ crossed: false }`.
   */
  storageThresholdState?: Record<string, StorageThresholdState>;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

/**
 * Canonical map key for a threshold value. Using a fixed-precision
 * string avoids float-equality footguns when persisting / looking up
 * `storageThresholdState` entries across reloads.
 *
 * Example: `0.8` → `"0.800"`; `1` → `"1.000"`.
 */
export function thresholdStateKey(threshold: number): string {
  return threshold.toFixed(3);
}

/**
 * Returns `true` if `incomingBytes` would push `usageBytes` past `quotaBytes`.
 * `quotaBytes === null` always returns `false` (unlimited).
 */
export function wouldExceedQuota(
  usageBytes: number,
  incomingBytes: number,
  quotaBytes: number | null
): boolean {
  if (quotaBytes === null || quotaBytes === undefined) return false;
  if (!Number.isFinite(quotaBytes) || quotaBytes < 0) return false;
  return usageBytes + incomingBytes > quotaBytes;
}
