# Feature Plan: Plugin Editing System

## Objective
Provide a modular, non-destructive editing framework for lightweight image adjustments.

## Scope
- Plugin manifest and capability registration
- Edit recipe format and versioning
- Client preview and server-side render consistency
- Plugin enable/disable controls by plan/workspace

## Current implementation (incremental)
- Recipe contract versioning (`recipeVersion: 1`) on apply-edits payloads
- Plugin manifest endpoint (`GET /edits/plugins`) for client capability discovery
  - Optional `?tenantId=` / `?libraryId=` query params filter the returned
    `enabled` flag through the per-tenant allowlist (issue #166); without
    them the manifest reflects only the global runtime state.
- Initial non-destructive plugin set exposed in manifest:
  - `crop`
  - `rotate`
  - `adjust` (brightness/contrast/saturation)
  - `filter` (grayscale/sepia/blur/sharpen/negate)
- Data model stores `recipeVersion` on every saved edit history entry
- Per-tenant plugin allowlist (issue #166) — see [Per-tenant allowlist](#per-tenant-allowlist-issue-166).

## Per-tenant allowlist (issue #166)
Hosts that resell AuraPix in tiers (e.g., Basic vs. Pro) can gate which
built-in plugins a given tenant's users may run.

### Storage
- Collection: `tenantPluginConfig`
- Document id: tenantId
- Shape: `{ tenantId, enabledPluginIds: string[], updatedAt, updatedBy }`
- **Default-on:** tenants without an explicit document behave as if every
  built-in plugin is enabled. The first read for such a tenant lazily
  materializes a default-on document (rollout backfill), so admin tooling
  always sees a stable, persisted record.

### Endpoints (host API key only)
- `GET /api/v1/tenants/:tenantId/plugins` — returns one entry per built-in
  plugin: `{ id, name, version, enabled, builtIn }`. Requires the
  `plugins.read` scope.
- `PUT /api/v1/tenants/:tenantId/plugins/:pluginId` — body `{ enabled: boolean }`.
  Requires the `plugins.write` scope. Returns `{ changed }` so callers can
  detect idempotent no-ops.

End-user Firebase tokens are NOT accepted on these endpoints — plugin
configuration is a host-tier concern.

### Enforcement
The edit executor (`POST /edits/:libraryId/:photoId`) checks the per-tenant
allowlist before running each operation in the recipe. Disabled plugins
are rejected with HTTP `403` and code `plugin_disabled_for_tenant`. This
enforcement is server-side: clients cannot bypass by calling the API
directly.

### Metering events
- `plugin.enabled` `{ tenantId, pluginId, actor }` — emitted on PUT only
  when the call transitions the plugin from disabled to enabled.
- `plugin.disabled` `{ tenantId, pluginId, actor }` — same, in reverse.
- `plugin.blocked` `{ tenantId, pluginId, userId }` — emitted by the
  executor when a user attempts to run a disabled plugin. Useful for
  upsell/audit signals.
- `plugin.ran` continues to fire only on successful execution (unchanged).

Idempotent no-op transitions emit no event so host billing stays stable.


## Planned detail expansion
- Plugin API contract (input, params, output)
- Workspace/plan-based plugin enable/disable policy
- Additional plugin set: exposure/white-balance/highlights
- Data storage model for edit versions/history
