/**
 * Service layer for per-tenant feature flag configuration (issue #175).
 *
 * Storage shape: a single document per tenant in
 * `TENANT_FEATURES_CONFIG_COLLECTION`, keyed by tenantId. The document
 * holds a sparse map of feature overrides; unset features fall back to
 * the default (`true`) so tenants without a doc retain full capability
 * (back-compat).
 *
 * Caching: hot path \u2014 `requireFeature` runs on every gated request.
 * The service maintains an in-memory TTL cache keyed by tenantId
 * (mirroring the branding service pattern). Cache writes are inline on
 * fetch and invalidated on mutation; default TTL is 30s, configurable
 * via env `TENANT_FEATURES_CACHE_TTL_MS` for hosts that want stricter
 * propagation guarantees.
 *
 * The cache is intentionally process-local: feature flag changes are
 * low-volume, the eventual-consistency window is bounded by the TTL,
 * and the host has access to the `feature.flag_changed` metering event
 * if they need stronger guarantees (they can flush their own caches
 * via a webhook fan-out).
 */

import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAG_NAMES,
  TENANT_FEATURES_CONFIG_COLLECTION,
  TRASH_RETENTION_MAX_DAYS,
  TRASH_RETENTION_MIN_DAYS,
  type FeatureFlagName,
  type TenantFeatureFlags,
  type TenantFeaturesConfigRecord,
} from '../../models/TenantFeaturesConfig.js';
import { logger } from '../../utils/logger.js';

interface CacheEntry {
  record: TenantFeaturesConfigRecord | null;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;

function resolveTtlMs(): number {
  const raw = process.env.TENANT_FEATURES_CACHE_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TTL_MS;
  return Math.floor(n);
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = resolveTtlMs();

/**
 * Discard the cache entry for a tenant. Called automatically on mutation
 * (`patchTenantFeatures`); exported for tests and explicit busts.
 */
export function invalidateTenantFeaturesCache(tenantId?: string | null): void {
  if (!tenantId) {
    cache.clear();
    return;
  }
  cache.delete(tenantId);
}

/**
 * Reset cache state. Test helper.
 */
export function __resetTenantFeaturesCacheForTests(): void {
  cache.clear();
}

/**
 * Fetch the raw config document for a tenant, or null if it does not
 * exist. Most callers should use `getEffectiveFeatureFlags` or
 * `isFeatureEnabled` instead.
 */
export async function fetchTenantFeaturesConfig(
  data: DataAdapter,
  tenantId: string
): Promise<TenantFeaturesConfigRecord | null> {
  if (!tenantId) return null;
  const now = Date.now();
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > now) {
    return cached.record;
  }
  const record = await data.fetchData<TenantFeaturesConfigRecord>(
    TENANT_FEATURES_CONFIG_COLLECTION,
    tenantId
  );
  cache.set(tenantId, { record: record ?? null, expiresAt: now + TTL_MS });
  return record ?? null;
}

/**
 * Resolve the effective feature flag state for a tenant. Unset flags
 * fall back to their default (`true`), so a tenant with no doc \u2014 or
 * a doc that predates a newly-added feature \u2014 reads as fully enabled.
 *
 * Unknown keys in the stored map are silently ignored so a stale flag
 * from an earlier deployment cannot accidentally grant access to a
 * route that does not (yet) gate on that flag.
 */
export async function getEffectiveFeatureFlags(
  data: DataAdapter,
  tenantId: string
): Promise<TenantFeatureFlags> {
  const doc = await fetchTenantFeaturesConfig(data, tenantId);
  return mergeWithDefaults(doc?.flags ?? null);
}

/**
 * Convenience helper used by middleware and bootstrap.
 *
 * Returns `true` when the named feature is enabled for the tenant.
 * Missing tenantId, missing doc, or missing flag entry all resolve to
 * the default (`true`).
 */
export async function isFeatureEnabled(
  data: DataAdapter,
  tenantId: string,
  feature: FeatureFlagName
): Promise<boolean> {
  if (!tenantId) return DEFAULT_FEATURE_FLAGS[feature];
  const flags = await getEffectiveFeatureFlags(data, tenantId);
  return flags[feature];
}

/**
 * Apply a partial update to a tenant's feature flags. Returns the new
 * record along with the previous flag state so callers can emit a
 * `feature.flag_changed` metering event for each transitioning flag.
 *
 * Unknown keys in the input are ignored (defense in depth against the
 * caller PATCHing a typo or a deprecated flag name).
 */
export async function patchTenantFeatures(
  data: DataAdapter,
  options: {
    tenantId: string;
    patch: Partial<TenantFeatureFlags>;
    actor?: string | null;
  }
): Promise<{
  record: TenantFeaturesConfigRecord;
  previous: TenantFeatureFlags;
  changes: Array<{ feature: FeatureFlagName; oldValue: boolean; newValue: boolean }>;
}> {
  const { tenantId, patch, actor } = options;
  if (!tenantId) {
    throw new Error('tenantId is required');
  }

  const existing = await data.fetchData<TenantFeaturesConfigRecord>(
    TENANT_FEATURES_CONFIG_COLLECTION,
    tenantId
  );
  const previous = mergeWithDefaults(existing?.flags ?? null);

  const nextFlags: Partial<TenantFeatureFlags> = { ...(existing?.flags ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (!isKnownFeature(key)) continue;
    if (typeof value !== 'boolean') continue;
    nextFlags[key] = value;
  }
  const effective = mergeWithDefaults(nextFlags);

  const changes: Array<{
    feature: FeatureFlagName;
    oldValue: boolean;
    newValue: boolean;
  }> = [];
  for (const name of FEATURE_FLAG_NAMES) {
    if (previous[name] !== effective[name]) {
      changes.push({
        feature: name,
        oldValue: previous[name],
        newValue: effective[name],
      });
    }
  }

  const now = new Date().toISOString();
  const record: TenantFeaturesConfigRecord = {
    tenantId,
    flags: nextFlags,
    // Preserve any existing per-tenant Trash retention override
    // (issue #183). `patchTenantFeatures` and `patchTrashRetention`
    // share the same underlying doc; flag mutations must NOT clobber a
    // separately-set retention value.
    ...(existing && 'trashRetentionDays' in existing
      ? { trashRetentionDays: existing.trashRetentionDays ?? null }
      : {}),
    updatedAt: now,
    updatedBy: actor ?? null,
  };

  await data.storeData(TENANT_FEATURES_CONFIG_COLLECTION, tenantId, record);
  invalidateTenantFeaturesCache(tenantId);

  return { record, previous, changes };
}

/**
 * Merge a sparse override map with the defaults to produce a complete
 * `TenantFeatureFlags` value. Exported for tests and the bootstrap
 * payload assembler.
 */
export function mergeWithDefaults(
  partial: Partial<TenantFeatureFlags> | null
): TenantFeatureFlags {
  const out: TenantFeatureFlags = { ...DEFAULT_FEATURE_FLAGS };
  if (!partial) return out;
  for (const name of FEATURE_FLAG_NAMES) {
    const v = partial[name];
    if (typeof v === 'boolean') {
      out[name] = v;
    }
  }
  return out;
}

function isKnownFeature(value: string): value is FeatureFlagName {
  return (FEATURE_FLAG_NAMES as readonly string[]).includes(value);
}

/**
 * Validate + clamp a candidate Trash retention value (issue #183).
 *
 * Returns the integer in `[TRASH_RETENTION_MIN_DAYS, TRASH_RETENTION_MAX_DAYS]`
 * when the input is a finite integer in range, otherwise `null`. Hosts
 * call `patchTrashRetention` which rejects invalid values; this helper
 * is also used on the read path so an out-of-band corrupt value falls
 * back to the deployment default rather than crashing the purge job.
 */
export function clampTrashRetentionDays(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (value < TRASH_RETENTION_MIN_DAYS) return null;
  if (value > TRASH_RETENTION_MAX_DAYS) return null;
  return value;
}

/**
 * Resolve the effective Trash retention window for a tenant
 * (issue #183).
 *
 * Lookup order:
 *   1. Per-tenant override on the features-config doc (when present
 *      and valid).
 *   2. The supplied deployment default (the caller passes the result
 *      of `resolveTrashRetentionDays(env)` from `purgeTrash.ts`).
 *
 * Invalid override values are logged at WARN and ignored — the job
 * MUST keep running on a sensible default rather than skipping the
 * tenant entirely (acceptance criteria for issue #183).
 */
export async function resolveTenantTrashRetentionDays(
  data: DataAdapter,
  tenantId: string,
  deploymentDefault: number
): Promise<number> {
  if (!tenantId) return deploymentDefault;
  const doc = await fetchTenantFeaturesConfig(data, tenantId);
  if (!doc) return deploymentDefault;
  const raw = doc.trashRetentionDays;
  if (raw === undefined || raw === null) return deploymentDefault;
  const clamped = clampTrashRetentionDays(raw);
  if (clamped === null) {
    logger.warn(
      { tenantId, raw },
      'tenantFeaturesConfig.trashRetentionDays is invalid; falling back to deployment default'
    );
    return deploymentDefault;
  }
  return clamped;
}

/**
 * Apply a Trash retention update to a tenant's features-config doc
 * (issue #183).
 *
 * `retentionDays` MUST be a finite integer in
 * `[TRASH_RETENTION_MIN_DAYS, TRASH_RETENTION_MAX_DAYS]`; out-of-range
 * inputs throw `RangeError` so the route layer can surface `400`.
 *
 * Pass `retentionDays: null` to clear the override and fall back to
 * the deployment default.
 *
 * Returns the new record plus `previous`/`next` retention values so
 * the caller can emit `feature.flag_changed` and audit events only
 * when the value actually transitioned.
 */
export async function patchTrashRetention(
  data: DataAdapter,
  options: {
    tenantId: string;
    retentionDays: number | null;
    actor?: string | null;
  }
): Promise<{
  record: TenantFeaturesConfigRecord;
  previous: number | null;
  next: number | null;
  changed: boolean;
}> {
  const { tenantId, retentionDays, actor } = options;
  if (!tenantId) {
    throw new Error('tenantId is required');
  }

  let nextValue: number | null;
  if (retentionDays === null) {
    nextValue = null;
  } else {
    const clamped = clampTrashRetentionDays(retentionDays);
    if (clamped === null) {
      throw new RangeError(
        `retentionDays must be an integer between ${TRASH_RETENTION_MIN_DAYS} and ${TRASH_RETENTION_MAX_DAYS}`
      );
    }
    nextValue = clamped;
  }

  const existing = await data.fetchData<TenantFeaturesConfigRecord>(
    TENANT_FEATURES_CONFIG_COLLECTION,
    tenantId
  );
  const previous = clampTrashRetentionDays(existing?.trashRetentionDays);
  const changed = previous !== nextValue;

  const now = new Date().toISOString();
  const record: TenantFeaturesConfigRecord = {
    tenantId,
    flags: existing?.flags ?? {},
    // Omit the key entirely when clearing so the doc shape stays clean.
    ...(nextValue === null
      ? { trashRetentionDays: null }
      : { trashRetentionDays: nextValue }),
    updatedAt: now,
    updatedBy: actor ?? null,
  };

  await data.storeData(TENANT_FEATURES_CONFIG_COLLECTION, tenantId, record);
  invalidateTenantFeaturesCache(tenantId);

  return { record, previous, next: nextValue, changed };
}
