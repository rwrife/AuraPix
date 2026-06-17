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
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
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
