# Feature Plan: Library & Organization

## Objective
Allow users to organize photos into albums and collections with fast browsing and filtering.

## Scope
- All Photos timeline/grid
- Albums CRUD
- Collections (albums grouped logically)
- Metadata display and search filters
- Favorites, tags, and quick views
- **Trash (soft-delete) with TTL purge** — recoverable photo deletion (issue #152)

## Planned detail expansion
- Firestore schema for albums, collections, and photo references
- UI layout patterns and pagination strategy
- Indexing strategy for common filter combinations
- Bulk actions and conflict handling

## Trash (soft-delete) for photos

_Tracking issue: [#152](https://github.com/rwrife/AuraPix/issues/152)._

AuraPix supports a recoverable Trash for photos, matching the UX users
expect from Lightroom, Apple Photos, and Google Photos. Deletes go to
Trash first; bytes are kept until a scheduled purge job hard-deletes
them after a retention window.

### Data model

Each `photo` document carries:

| Field | Type | Notes |
| --- | --- | --- |
| `trashedAt` | ISO-8601 string \| null | Set when soft-deleted; `null` when active. |
| `trashedBy` | string \| null | User id (or tenant subject) that initiated the delete. |

### Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `DELETE` | `/v1/photos/:id` | **Soft delete.** Sets `trashedAt = now`; the photo no longer appears in default list queries. Returns `200`. |
| `POST` | `/v1/photos/:id/restore` | Clears `trashedAt` / `trashedBy`. Cross-tenant restore returns `403`. |
| `GET` | `/v1/photos?trashed=true` | Lists the caller's tenant's trash. |
| `GET` | `/v1/photos` | Lists active (non-trashed) photos for the caller's tenant. |

All routes are tenant-scoped via the existing `resolveTenant`
middleware and enforce `assertSameTenant` in the service layer.

### TTL purge job

A scheduled job (`functions/src/jobs/purgeTrash.ts`) hard-deletes photos
whose `trashedAt` is older than the effective retention window
(deployment default **30** days, set via `TRASH_RETENTION_DAYS` env var,
optionally overridden per tenant — see [Per-tenant Trash retention](#per-tenant-trash-retention-issue-183) below). The job:

- Iterates **per-tenant** so one noisy tenant cannot starve others.
- Resolves retention per tenant (override > deployment default) so
  tiered plans can offer different retention windows.
- Reuses the storage-cleanup path on the existing `StorageAdapter`
  (no new storage code).
- Caps work per tenant per run via `perTenantLimit` (default 1000).
- Emits `photo.purged` exactly once per photo (see
  [Metering Events](./metering-events.md)).

### Per-tenant Trash retention (issue #183)

Hosts that resell AuraPix on tiered plans (e.g. Free / Pro / Business)
can override Trash retention per tenant. The override lives on the
shared per-tenant config doc (`tenantFeaturesConfig`, the same
collection used by feature flags from #175):

```ts
interface TenantFeaturesConfigRecord {
  tenantId: string;
  flags: Partial<TenantFeatureFlags>;
  /** Issue #183: per-tenant Trash retention, integer in [1, 365] days. */
  trashRetentionDays?: number | null;
  updatedAt: string;
  updatedBy: string | null;
}
```

Resolution order on the purge hot path:

1. `trashRetentionDays` on the tenant config doc, when set and within
   `[1, 365]`. Out-of-range / non-integer values log a warning and are
   ignored.
2. Deployment default (`TRASH_RETENTION_DAYS` env, or `30`).

#### Endpoints

Both endpoints require a host API key with the `tenant.config` scope.
Cross-tenant requests return `403`.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/v1/tenants/:tenantId/config/trash` | Returns the effective retention window, the override (or `null`), the deployment default, and the source (`"tenant"` or `"deployment"`). |
| `PATCH` | `/v1/tenants/:tenantId/config/trash` | Body: `{ "retentionDays": <int 1..365> | null }`. Sets the per-tenant override, or pass `null` to clear and revert to the deployment default. |

`PATCH` emits a `feature.flag_changed` metering event with
`flag="trash.retentionDays"` and the old / new values when the override
transitions, and writes a `tenant.config.trash.updated` audit event for
compliance trails. The `photo.purged` event keeps firing on the actual
purge — longer retention naturally lengthens the storage-GB billable
window via the existing `usageDaily` rollups, so no new event types are
required.

### Multi-tenant considerations

- Trash retention is strictly per-tenant; cross-tenant reads return
  `403`. The deployment-wide `TRASH_RETENTION_DAYS` env value is the
  fallback when no override is set.
- The purge job's per-tenant iteration is a soft fairness guarantee
  driven by `perTenantLimit`; production wiring should run the job on a
  cadence short enough that the limit drains backlogs within SLA.

## Keyword tags (Lightroom-style)

_Tracking issue: [#173](https://github.com/rwrife/AuraPix/issues/173)._

Photos accept freeform keyword tags (e.g. `wedding`, `client:smith`,
`print-ready`) for triage and downstream filtering by Smart Albums (#165).

### Data model

```ts
interface Photo {
  // ...existing fields...
  tags?: string[]; // normalized lowercase, 1–64 chars each, ≤ 50 per photo
}
```

Tags are normalized before storage:

- trimmed and lowercased,
- internal whitespace runs collapsed to a single space,
- duplicates removed (first occurrence wins),
- empty strings dropped silently.

### Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/photos/:id/tags` | Body `{ add?: string[], remove?: string[] }`. Idempotent: re-adding a present tag (or removing an absent one) is a no-op. |
| `GET`  | `/v1/libraries/:id/tags` | Returns `{ tags: [{ tag, count }] }` sorted by count desc, then tag asc. Only non-trashed photos contribute to counts. |
| `GET`  | `/v1/photos?tags=a,b` | Filters photos with **AND** semantics across the supplied tag list. |

All routes pass through the existing tenant-id middleware; cross-tenant
reads and writes return `403 FORBIDDEN`.

### Multi-tenant considerations

- Tag vocabulary is scoped **per library**, not per tenant. Two libraries
  on the same tenant therefore maintain independent vocabularies, which
  matches how photographers separate work (e.g. `client-a` vs
  `personal`).
- The `/v1/libraries/:id/tags` endpoint reuses the tenant-scoped photo
  list path, so it cannot enumerate tags from libraries the caller does
  not own.

### Smart Albums interaction

The Smart Albums filter DSL already accepts a `tags` clause (issue #165).
That clause uses **ANY-of** semantics inside a saved filter so a
"wedding work" album can match either `wedding` *or* `engagement`. The
photos list endpoint (`/v1/photos?tags=`) uses **AND** semantics so the
UI's quick filter narrows progressively. The two are intentionally
distinct because they serve different surfaces.

### Metering

Each mutation emits a single `photo.tagged` event (not one per tag) with
`meta.added` and `meta.removed` counts. The `tagsApplied` daily counter
sums `added + removed` so hosts can show "organizational activity" or
gate on it for higher tiers. See
[Metering Events](./metering-events.md) and
[Usage & Billing](./usage-and-billing.md).

### Firestore index

A composite index on `(tenantId, libraryId, tags array-contains,
updatedAt desc)` supports the tag-narrowed photo query without
collection-scan amplification.

## Ad-hoc Search (issue #207)

Smart Albums (above) are the answer for **saved** filters that materialize
over time. `POST /v1/photos:search` is the answer for **one-shot** queries
— the user types "sunset", "canon 5d", "last month", "5-star only", or
"red-label" into a search box and expects results back immediately.

```
POST /v1/photos:search
{
  "libraryId": "lib_...",
  "q": "sunset",                        // case-insensitive prefix on filenameLower + exact tag match
  "tags": ["travel", "family"],         // AND semantics
  "rating": { "gte": 4 },
  "flag": "pick",                       // or "reject" / "unflagged"
  "colorLabel": "red",                  // or ..., "none"
  "capturedBetween": { "from": "2026-01-01T00:00:00Z", "to": "2026-02-01T00:00:00Z" },
  "camera": "5D",
  "trashed": false,
  "limit": 50,
  "cursor": "..."
}
→ 200 { items: PhotoSummary[], nextCursor?: string, totalEstimate?: number }
```

The endpoint composes the existing photo indexes; there is no new
storage engine and no full-text yet. Full-text (filename substring,
caption search, semantic/vector search) is intentionally deferred.

### Query planner and 409

Filter combinations that would require an index we do not currently
maintain (for example, cross-library search over a tenant without
`libraryId`) return HTTP `409 unsupported_query_combination` with a
machine-readable `hint`. There is deliberately no silent client-side
filtering fallback — hosts must see the 409 so we can add the missing
index in a follow-up without breaking callers.

### Feature flag

Gated by the per-tenant `search` feature flag (default-on). Hosts can
disable search on Free-tier tenants and enable it on Pro tiers via
`PATCH /v1/tenants/:id/features`.

### Metering

- `photos.searched { libraryId, resultCount, hasFullText, filterCount }`
  — one billable event per successful call, regardless of result count.
- `photos.search.unsupported { requestedFilters }` — non-billable; emitted
  when the query planner rejects a combo with 409, so hosts can spot
  demand for indexes we do not yet maintain.

### Idempotency

`Idempotency-Key` is honored on this endpoint so a retried POST after a
network blip replays the original response instead of double-metering.

### `filenameLower`

To support the case-insensitive prefix on `q`, the Photo document
carries a denormalized `filenameLower` field written at photo-create
time (and on rename). Older photos written before the search rollout
may lack the field; the handler falls back to
`originalName.toLowerCase()` in memory for those.
