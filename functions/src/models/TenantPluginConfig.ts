/**
 * Per-tenant plugin allowlist (issue #166).
 *
 * Hosts that resell AuraPix in different tiers (e.g., Basic vs. Pro) need to
 * gate which built-in plugins a given tenant's users may run. This document
 * stores, per tenant, the explicit set of enabled plugin ids.
 *
 * Default-on behavior: when a tenant has no `tenant_plugin_config` document
 * yet, the executor MUST behave as if every built-in plugin from the
 * `EDIT_PLUGIN_MANIFEST` is enabled. The first read for a tenant lazily
 * materializes a doc containing the full enabled set (see
 * `getOrInitTenantPluginConfig` in `tenantPluginConfigService.ts`).
 *
 * Configuration is strictly per tenant — there is no global override that
 * can be applied at a tenant scope (matches issue #166 multi-tenant guard).
 */

export const TENANT_PLUGIN_CONFIG_COLLECTION = 'tenantPluginConfig';

export interface TenantPluginConfigRecord {
  /**
   * Document id; equal to `tenantId`. Using tenantId as the document id
   * keeps lookups O(1) and keeps configuration strictly per-tenant.
   */
  tenantId: string;

  /**
   * Set of plugin ids (built-in `EditOperationType` values) that are
   * enabled for this tenant. The executor uses this as an allowlist —
   * any plugin not in this list is blocked with `plugin_disabled_for_tenant`.
   */
  enabledPluginIds: string[];

  /** ISO-8601 timestamp of the last enable/disable mutation. */
  updatedAt: string;

  /**
   * Identifier of the principal that last updated the doc. For host
   * API key actors this is the API key id (e.g. `tak_...`); for admin
   * users it is their uid. May be null for system-initialized docs
   * (e.g. lazy backfill on first read).
   */
  updatedBy: string | null;
}
