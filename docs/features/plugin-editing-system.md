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

## Develop presets — save + apply to many photos (issue #197)
Lightroom-style "sync settings": save the edit recipe of one photo as a
reusable **preset** and apply it to a selection of other photos. Presets
are a saved-and-labelled `EditRecipe` — they reuse the exact same
executor pipeline as the single-photo `POST /edits/:libraryId/:photoId`
surface, so there is no new render path to reason about.

### Storage
- Collection: `tenantEditPresets`
- Document id: composite `"{tenantId}__{presetId}"` (keeps flat KV
  adapters tenant-safe by construction)
- Shape:
  ```jsonc
  {
    "id": "<uuid>",
    "tenantId": "<tenantId>",
    "name": "Warm Tone",
    "recipe": {
      "recipeVersion": 1,
      "operations": [
        { "type": "adjust", "params": { "brightness": 0.1 }, "order": 0 }
      ]
    },
    "createdBy": "<uid or host key id>",
    "createdAt": "<ISO8601>",
    "updatedAt": "<ISO8601>"
  }
  ```
- **Caps:** 500 presets per tenant; every preset is strictly
  tenant-scoped (never global, never cross-tenant).

### Endpoints
All endpoints accept EITHER a Firebase user token (with an appropriate
tenant-member role) OR a host API key carrying the matching scope. All
are mounted under both `/v1/tenants/...` (canonical) and
`/api/v1/tenants/...` (legacy in-product path).

- `POST /v1/tenants/:tenantId/edit-presets` — create a preset.
  Body: either `{ name, recipe }` or `{ name, fromPhotoId }`. When
  `fromPhotoId` is supplied, the current edit version of that photo is
  copied as the preset's recipe. Requires `edit-presets.write` scope /
  `editor+` role.
- `GET /v1/tenants/:tenantId/edit-presets` — list all presets in the
  tenant, sorted by `createdAt` ascending. Requires `edit-presets.read`
  scope / `viewer+` role.
- `DELETE /v1/tenants/:tenantId/edit-presets/:presetId` — remove a
  preset. Returns 404 when unknown. Requires `edit-presets.write` scope
  / `editor+` role.
- `POST /v1/tenants/:tenantId/edit-presets/:presetId/apply` — bulk apply
  a preset to up to 200 photoIds. Body: `{ photoIds: string[] }`.
  Requires `edit-presets.write` scope / `editor+` role. Supports
  `Idempotency-Key` so retries return the same body without re-committing
  edits or re-emitting metering events. Cross-tenant photoIds fail the
  WHOLE batch with HTTP 400 `CROSS_TENANT_PHOTO_ID`, mirroring the
  bulk-op contract from #142.

### Response shape for apply
```jsonc
{
  "presetId": "<uuid>",
  "requested": 3,
  "applied": 2,
  "failed": 1,
  "results": [
    { "photoId": "a", "status": "applied", "version": 4 },
    { "photoId": "b", "status": "applied", "version": 2 },
    { "photoId": "c", "status": "error",
      "error": { "code": "PHOTO_NOT_FOUND", "message": "..." } }
  ]
}
```
Partial success is expected — the request itself is 200; per-photo
outcomes live in `results[]`.

### Enforcement
- Recipe validation on create runs the same `validateOperations` used by
  the single-photo executor, so a preset cannot store a recipe the
  executor would refuse.
- Apply re-checks the per-tenant plugin allowlist per photo. If a plugin
  was disabled AFTER a preset was created, applying the preset yields
  per-photo `status: "error"` with code `plugin_disabled_for_tenant` and
  emits `plugin.blocked` (as usual for allowlist-blocked ops).
- Cross-tenant photoIds are rejected batch-wide, not partially.

### Metering events
- `edit.applied` — emitted **per successfully edited photo** in the apply
  batch (identical shape to the single-photo pipeline). Includes
  `meta.viaPreset: true` and `meta.presetId` so hosts can attribute
  applies to preset usage.
- `edit_preset.applied` — emitted **once per apply call**, regardless of
  batch outcome. Meta: `{ presetId, photoCount, succeeded, failed }`.
  Non-billable (a signal for analytics/product); the billable event is
  the per-photo `edit.applied`.
- `plugin.ran` continues to fire per-op on success, unchanged.

### API key scopes
- `edit-presets.read` — list.
- `edit-presets.write` — create, delete, apply.
