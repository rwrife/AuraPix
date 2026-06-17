# Smart Albums

> Saved filter queries that materialize on read. Issue #165.

## Why

AuraPix already has albums (manual collections), and we have ratings, flags,
and tags that are used to triage photos. A core Lightroom-like workflow is the
*Smart Collection* — a saved filter (e.g., "5-star + flagged + 2026") that
automatically reflects matching photos without the user having to manually
curate them.

Smart Albums let users save a filter as a named, sidebar-visible "album"
that re-evaluates the moment they open it.

## Model

A Smart Album is **not** a collection of photo ids — it has no membership
table. Instead it stores a small validated filter DSL:

```ts
interface SmartAlbumFilter {
  rating?: { gte?: number; lte?: number };   // 0..5 inclusive
  flag?: 'pick' | 'reject';
  tags?: string[];                           // any-of, max 50
  capturedBetween?: [string, string];        // ISO-8601, inclusive
  mimeTypes?: string[];                      // any-of, max 50
}
```

The filter is parsed with a strict zod schema (`z.object({...}).strict()`),
so unknown keys are hard-rejected. This prevents callers from smuggling
arbitrary fields into the Firestore query layer across tenants.

A Smart Album document looks like:

| Field       | Type             | Notes                                 |
| ----------- | ---------------- | ------------------------------------- |
| `id`        | uuid             | Server-generated.                     |
| `tenantId`  | string           | Inherited from the calling tenant.    |
| `libraryId` | string           | Required, validated on every request. |
| `ownerId`   | string           | The user who created the album.       |
| `name`      | string (1..120)  | Trimmed; required.                    |
| `filter`    | SmartAlbumFilter | Validated DSL.                        |
| `createdAt` | ISO-8601         |                                       |
| `updatedAt` | ISO-8601         |                                       |

## Endpoints

All routes require Bearer auth and apply the existing `resolveTenant`
middleware so cross-tenant reads/writes return `403`.

| Method | Path                                          | Purpose                          |
| ------ | --------------------------------------------- | -------------------------------- |
| `GET`  | `/v1/libraries/:libraryId/smart-albums`       | List smart albums in a library.  |
| `POST` | `/v1/libraries/:libraryId/smart-albums`       | Create a new smart album.        |
| `GET`  | `/v1/smart-albums/:id`                        | Fetch metadata.                  |
| `GET`  | `/v1/smart-albums/:id/photos`                 | Materialize the saved filter.    |
| `PATCH`| `/v1/smart-albums/:id`                        | Rename or replace the filter.    |
| `DELETE`| `/v1/smart-albums/:id`                       | Delete a smart album.            |

The same routes are mirrored under `/api/v1/...` for in-product clients.

### Materialize semantics

`GET /v1/smart-albums/:id/photos`:

1. Resolves the smart album, validating tenant scope.
2. Re-validates the stored filter (defense in depth — a corrupted document
   cannot crash a read).
3. Queries `photos` with indexed equality on `(tenantId, libraryId)` and
   filters out trashed photos.
4. Applies the DSL clauses in-memory.
5. Sorts by `updatedAt DESC, id ASC` for stable pagination.
6. Returns `{ photos, nextPageToken, total }`.

The `nextPageToken` is an opaque base64url-encoded JSON cursor.
`pageSize` defaults to 50 and is clamped to `[1, 200]`.

### Errors

| Code                          | HTTP | When                                                    |
| ----------------------------- | ---- | ------------------------------------------------------- |
| `SMART_ALBUM_NOT_FOUND`       | 404  | Album does not exist.                                   |
| `SMART_ALBUM_INVALID_FILTER`  | 400  | Filter fails zod validation (e.g., unknown key, range). |
| `SMART_ALBUM_CAP_EXCEEDED`    | 409  | Per-library cap (200) reached; details include cap.     |
| `cross-tenant-access`         | 403  | Album exists in another tenant.                         |
| `AUTH_REQUIRED`               | 401  | Missing/invalid auth.                                   |

## Multi-tenant safety

- `tenantId` comes from the resolved request context, never from the body
  or query.
- The repository scopes lists by `(tenantId, libraryId)`; the service
  additionally filters cross-tenant rows after fetching.
- `assertSameTenant` is called before every read/write of an existing
  album, surfacing `403` for cross-tenant access.

## Limits

- 200 smart albums per library, per tenant. Configurable via
  `SmartAlbumsServiceOptions.cap` for testing.
- Filter `tags` and `mimeTypes` arrays are capped at 50 entries each.
- Names are trimmed and capped at 120 characters.

## Indexes

`firestore.indexes.json` adds two composite indexes:

- `smartAlbums(tenantId ASC, libraryId ASC, createdAt DESC)` —
  list endpoint.
- `photos(tenantId ASC, libraryId ASC, updatedAt DESC)` —
  materialize endpoint.

No new wildcard scans are introduced.

## Metering

The service emits three event types via the existing metering bus:

| Event                       | When                                                    |
| --------------------------- | ------------------------------------------------------- |
| `smart_album.created`       | After a successful `POST /smart-albums`.                |
| `smart_album.deleted`       | After a successful `DELETE /smart-albums/:id`.          |
| `smart_album.materialized`  | After every `GET /smart-albums/:id/photos`. Includes `meta.resultCount` so hosts can detect heavy patterns. |

See [`metering-events.md`](./metering-events.md) for the full catalogue.

## UI

The web sidebar's existing "Albums" section now includes a sibling
"Smart Albums" section. Each smart album opens in the existing photo
grid via `/smart-albums/:id`. Smart Albums are read-only by definition
— users cannot add or remove individual photos.
