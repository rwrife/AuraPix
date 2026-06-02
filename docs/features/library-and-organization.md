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
whose `trashedAt` is older than `TRASH_RETENTION_DAYS` (default **30**,
env-configurable per deployment). The job:

- Iterates **per-tenant** so one noisy tenant cannot starve others.
- Reuses the storage-cleanup path on the existing `StorageAdapter`
  (no new storage code).
- Caps work per tenant per run via `perTenantLimit` (default 1000).
- Emits `photo.purged` exactly once per photo (see
  [Metering Events](./metering-events.md)).

### Multi-tenant considerations

- `TRASH_RETENTION_DAYS` is a deployment-wide default; a follow-up may
  move it onto the tenant config doc when a host requests per-tenant
  retention.
- The purge job's per-tenant iteration is a soft fairness guarantee
  driven by `perTenantLimit`; production wiring should run the job on a
  cadence short enough that the limit drains backlogs within SLA.
