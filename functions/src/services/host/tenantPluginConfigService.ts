/**
 * Service layer for per-tenant plugin allowlist (issue #166).
 *
 * Storage shape: a single document per tenant in
 * `TENANT_PLUGIN_CONFIG_COLLECTION`, keyed by tenantId. The document holds
 * the explicit set of enabled plugin ids — no global overrides apply.
 *
 * Defaults: tenants without an explicit document are treated as having
 * every built-in plugin enabled. The first read for such a tenant lazily
 * materializes a document containing the full enabled set so subsequent
 * reads are deterministic and admin tooling can see the effective state.
 */

import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import {
  TENANT_PLUGIN_CONFIG_COLLECTION,
  type TenantPluginConfigRecord,
} from '../../models/TenantPluginConfig.js';
import {
  EDIT_PLUGIN_MANIFEST,
  type EditOperationType,
} from '../edits/pluginRegistry.js';

const ALL_PLUGIN_IDS: EditOperationType[] = EDIT_PLUGIN_MANIFEST.map(
  (plugin) => plugin.id
);
const ALL_PLUGIN_ID_SET = new Set<string>(ALL_PLUGIN_IDS);

/**
 * Default enabled set used when a tenant has no explicit configuration
 * document yet. Every built-in plugin is enabled — this matches issue #166
 * default-on behavior and ensures existing tenants keep their current
 * functionality on first rollout.
 */
export function defaultEnabledPluginIds(): EditOperationType[] {
  // Return a fresh copy so callers cannot mutate the shared default array.
  return [...ALL_PLUGIN_IDS];
}

/**
 * Fetch the raw config document for a tenant, or null if it does not exist.
 * Most callers should use `getEffectiveEnabledPluginIds` or
 * `getOrInitTenantPluginConfig` instead — this is an escape hatch for
 * tooling that must distinguish between "default-on" and "explicitly set".
 */
export async function fetchTenantPluginConfig(
  data: DataAdapter,
  tenantId: string
): Promise<TenantPluginConfigRecord | null> {
  if (!tenantId) return null;
  return data.fetchData<TenantPluginConfigRecord>(
    TENANT_PLUGIN_CONFIG_COLLECTION,
    tenantId
  );
}

/**
 * Resolve the effective set of enabled plugin ids for a tenant, applying
 * the default-on policy when no explicit doc exists. Unknown plugin ids
 * stored in the doc are filtered out so a stale entry cannot accidentally
 * grant access to a removed plugin.
 */
export async function getEffectiveEnabledPluginIds(
  data: DataAdapter,
  tenantId: string
): Promise<Set<EditOperationType>> {
  const doc = await fetchTenantPluginConfig(data, tenantId);
  // Treat a missing doc OR a malformed doc (no enabledPluginIds array) as
  // "default-on": every built-in plugin is enabled. This also defends
  // existing call sites whose data adapters are not collection-aware in
  // tests — it cannot accidentally grant access to a *removed* plugin.
  if (!doc || !Array.isArray(doc.enabledPluginIds)) {
    return new Set(ALL_PLUGIN_IDS);
  }
  const ids = new Set<EditOperationType>();
  for (const id of doc.enabledPluginIds) {
    if (typeof id === 'string' && ALL_PLUGIN_ID_SET.has(id)) {
      ids.add(id as EditOperationType);
    }
  }
  return ids;
}

/**
 * Read-or-initialize: returns the existing doc, or — when none exists —
 * lazily writes a default-on doc and returns it. This is the function the
 * GET endpoint uses so that the first read for a brand-new tenant returns
 * a stable, persisted record.
 *
 * The lazy write is fire-and-forget (errors are logged via the data
 * adapter); on a write failure we still return the in-memory default doc
 * so the API stays available.
 */
export async function getOrInitTenantPluginConfig(
  data: DataAdapter,
  tenantId: string,
  options: { actor?: string | null } = {}
): Promise<TenantPluginConfigRecord> {
  const existing = await fetchTenantPluginConfig(data, tenantId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const initial: TenantPluginConfigRecord = {
    tenantId,
    enabledPluginIds: defaultEnabledPluginIds(),
    updatedAt: now,
    updatedBy: options.actor ?? null,
  };

  try {
    await data.storeData(TENANT_PLUGIN_CONFIG_COLLECTION, tenantId, initial);
  } catch {
    // Storage errors are best-effort here; falling back to the in-memory
    // default keeps reads stable. Mutations (PUT) still error if storage
    // is unavailable.
  }

  return initial;
}

/**
 * Mutate the enabled state for a single plugin under a tenant.
 *
 * Returns:
 *   - `record`:   the new persisted document.
 *   - `previous`: whether the plugin was previously enabled (best-effort —
 *                 derived from the existing doc, or the default-on policy
 *                 when no doc exists). Callers use this to decide whether
 *                 to emit a `plugin.enabled` / `plugin.disabled` metering
 *                 event (no-op transitions are not metered).
 *   - `changed`:  shorthand for `previous !== enabled`.
 */
export async function setTenantPluginEnabled(
  data: DataAdapter,
  options: {
    tenantId: string;
    pluginId: EditOperationType;
    enabled: boolean;
    actor?: string | null;
  }
): Promise<{
  record: TenantPluginConfigRecord;
  previous: boolean;
  changed: boolean;
}> {
  const { tenantId, pluginId, enabled, actor } = options;
  if (!tenantId) {
    throw new Error('tenantId is required');
  }
  if (!ALL_PLUGIN_ID_SET.has(pluginId)) {
    throw new Error(`Unknown plugin id: ${pluginId}`);
  }

  const existing = await fetchTenantPluginConfig(data, tenantId);
  const previousEnabledSet = new Set<string>(
    existing
      ? existing.enabledPluginIds.filter((id) => ALL_PLUGIN_ID_SET.has(id))
      : ALL_PLUGIN_IDS
  );
  const previous = previousEnabledSet.has(pluginId);

  if (enabled) {
    previousEnabledSet.add(pluginId);
  } else {
    previousEnabledSet.delete(pluginId);
  }

  const now = new Date().toISOString();
  const record: TenantPluginConfigRecord = {
    tenantId,
    enabledPluginIds: ALL_PLUGIN_IDS.filter((id) =>
      previousEnabledSet.has(id)
    ),
    updatedAt: now,
    updatedBy: actor ?? null,
  };

  await data.storeData(TENANT_PLUGIN_CONFIG_COLLECTION, tenantId, record);

  return {
    record,
    previous,
    changed: previous !== enabled,
  };
}

/**
 * Test/observability helper: list every supported plugin id. Exposed so the
 * route layer can build a stable response order without re-importing the
 * manifest.
 */
export function listAllPluginIds(): EditOperationType[] {
  return [...ALL_PLUGIN_IDS];
}
