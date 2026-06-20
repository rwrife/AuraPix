/**
 * Per-tenant feature flag config (issue #175).
 *
 * Hosts that resell AuraPix on tiered pricing plans need to map plan
 * tiers (Free / Pro / Business) to capability \u2014 e.g. Free tenants
 * cannot use plugins or sharing, Pro tenants cannot use the export API.
 * This document stores, per tenant, the explicit on/off state for each
 * gated feature.
 *
 * Default-on behavior: when a tenant has no `tenantFeaturesConfig`
 * document yet, every feature MUST behave as if enabled (back-compat
 * for existing tenants pre-rollout). The service layer resolves
 * unset flags to `true`.
 *
 * Configuration is strictly per tenant. There is no global override
 * or cross-tenant inheritance.
 */

export const TENANT_FEATURES_CONFIG_COLLECTION = 'tenantFeaturesConfig';

/**
 * Canonical list of gateable feature names. Adding a new feature here
 * is the only place required \u2014 routes opt in by passing the name to
 * `requireFeature(name)`, the GET response will include the new key
 * automatically (defaulting to `true` until the host PATCHes it), and
 * the embedded UI bootstrap payload will surface it for hide/show.
 */
export const FEATURE_FLAG_NAMES = [
  'sharing',
  'plugins',
  'smartAlbums',
  'export',
  'bulkOps',
] as const;

export type FeatureFlagName = (typeof FEATURE_FLAG_NAMES)[number];

export type TenantFeatureFlags = Record<FeatureFlagName, boolean>;

export interface TenantFeaturesConfigRecord {
  /**
   * Document id; equal to `tenantId`. Using tenantId as the document id
   * keeps lookups O(1) and keeps configuration strictly per-tenant.
   */
  tenantId: string;

  /**
   * Sparse map of feature flag overrides. Unset features fall back to
   * the default (`true`). Stored as a partial map so legacy docs that
   * predate a new feature name read cleanly as "default-on".
   */
  flags: Partial<TenantFeatureFlags>;

  /** ISO-8601 timestamp of the last mutation. */
  updatedAt: string;

  /**
   * Identifier of the principal that last updated the doc. For host
   * API key actors this is the API key id (e.g. `tak_...`); for admin
   * users it is their uid. May be null for system-initialized docs.
   */
  updatedBy: string | null;
}

/** Default feature state when no doc exists \u2014 every feature is enabled. */
export const DEFAULT_FEATURE_FLAGS: TenantFeatureFlags = {
  sharing: true,
  plugins: true,
  smartAlbums: true,
  export: true,
  bulkOps: true,
};
