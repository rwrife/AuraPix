# Usage & Billing

AuraPix exposes a stable, low-cost surface for hosts to invoice their own
customers: per-tenant **daily usage rollups**.

This page documents the counters, where they come from, and how to pull them.

## Endpoint

```
GET /api/v1/tenants/{tenantId}/usage?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv]
```

- **Auth:** tenant owner (Bearer token) **or** a host API key with the
  `usage.read` scope.
- **Range:** inclusive, UTC days, **max 100 days per call**.
- **Cross-tenant access:** always returns `403 FORBIDDEN`.
- **Response shape:** one document per day in the range, zero-filled for
  days with no activity so callers can iterate without gap handling. See
  the [OpenAPI contract](../../contracts/openapi/tenant-usage.openapi.json)
  for the precise schema.
- **Response format (issue #186):** JSON by default; CSV when the request
  sends `Accept: text/csv` **or** the query parameter `?format=csv`. CSV
  responses are streamed (chunked transfer encoding) so even the maximum
  100-day range never has to be buffered in memory.

### CSV column order (locked contract)

The CSV variant emits one header row followed by one row per UTC day in
the range — including zero-filled days. Columns appear in **exactly** the
following order, and this order is part of the public contract:

```
tenantId, date, storageBytesDelta, imagesUploaded, imagesProcessed,
signedUrlsIssued, editsApplied, tagsApplied, apiCalls, exportBytes,
activeUsers, rateLimited, storageBytesTotal, updatedAt, shareEgressBytes
```

Guarantees:

- Existing columns will never be renamed, reordered, or removed.
- New counters are only ever appended at the end of the row.
- Cells follow RFC 4180: fields containing `,`, `"`, CR, or LF are
  wrapped in double quotes and embedded `"` is escaped as `""`.
- `storageBytesTotal` is rendered as an empty cell until the daily
  snapshot job writes a value for that date.
- The response sets
  `Content-Disposition: attachment; filename="usage-<tenantId>-<from>-to-<to>.csv"`.

The locked order also lives in `CSV_COLUMNS` in
`functions/src/routes/tenantUsage.ts` and as `CsvColumnOrder` in the
OpenAPI contract. Any change to those three must land in the same commit.

Example (range `2026-04-01 .. 2026-04-03`, two days of activity then a
zero-filled day):

```csv
tenantId,date,storageBytesDelta,imagesUploaded,imagesProcessed,signedUrlsIssued,editsApplied,tagsApplied,apiCalls,exportBytes,activeUsers,rateLimited,storageBytesTotal,updatedAt,shareEgressBytes
tenant-A,2026-04-01,0,0,0,0,0,0,4,0,0,0,,2026-04-02T10:00:00.000Z,0
tenant-A,2026-04-02,1024,2,0,0,0,0,0,0,0,0,,2026-04-02T10:00:00.000Z,0
tenant-A,2026-04-03,0,0,0,0,0,0,0,0,0,0,,1970-01-01T00:00:00.000Z,0
```

## Month-to-date summary (issue #188)

Hosts that just want to render an in-app "Usage this month" widget can call
the summary endpoint instead of fanning out up to 31 reads against `/usage`:

```
GET /api/v1/tenants/{tenantId}/usage/current
```

- **Auth:** identical to `/usage` — tenant owner (Bearer) **or** a host API
  key with the `usage.read` scope (no new scope).
- **Period window:** `periodStart` is the first day of the current UTC
  month and `periodEnd` is today's UTC date. The endpoint never looks
  ahead to days that have not yet happened.
- **Zero activity:** the response is well-defined for tenants with zero
  activity — every counter is `0`, not a `404`.
- **Cross-tenant access:** always returns `403 FORBIDDEN`, same as
  `/usage`.

### Counter semantics

The response carries exactly the **summable** counters of `usageDaily`
(`storageBytesDelta`, `imagesUploaded`, `imagesProcessed`,
`signedUrlsIssued`, `editsApplied`, `tagsApplied`, `apiCalls`,
`exportBytes`, `shareEgressBytes`, `activeUsers`, `rateLimited`) plus
`tenantId`, `periodStart`, `periodEnd`, and a `generatedAt` timestamp.

Fields **excluded** from the summary:

- `storageBytesTotal` — point-in-time snapshot, not summable.
- `appliedEventIds` — idempotency bookkeeping, not a billing field.
- `updatedAt` — per-day metadata; the summary has its own
  `generatedAt` instead.

`activeUsers` is the **distinct** end-user count for the period in
production (de-duplicated across days via the `DistinctActiveUsersQuery`
capability on `UserActiveDailyStore`). When the capability is not wired
— e.g. during local-dev with only the in-memory store — the field falls
back to summing per-day `activeUsers`, which is a conservative upper
bound. The behaviour is identical to how the daily doc's per-day
`activeUsers` is computed (driven by `user.active` metering events, not
re-emitted on every request).

### Caching

- Each tenant's summary is cached in-memory for **~60 seconds** to keep
  cost predictable when hosts hit the endpoint on every dashboard load.
- The cache is **invalidated explicitly** when `usageDaily` is written
  through the same process (`router.invalidateTenantCurrentCache(...)`).
- In a multi-process deployment the eventual-consistency window is
  bounded by the 60s TTL; hosts that need stricter freshness should
  cache-bust on their side.
- The response sets `Cache-Control: private, max-age=60` so a fronting
  CDN can also cache for ~60s without serving cross-tenant data.
- The `X-Cache: HIT|MISS` response header is diagnostic only — not part
  of the billing contract.

### Example payload

```json
{
  "tenantId": "tenant-A",
  "periodStart": "2026-04-01",
  "periodEnd": "2026-04-15",
  "generatedAt": "2026-04-15T12:34:56.000Z",
  "storageBytesDelta": 5242880,
  "imagesUploaded": 42,
  "imagesProcessed": 91,
  "signedUrlsIssued": 314,
  "editsApplied": 8,
  "tagsApplied": 17,
  "apiCalls": 1023,
  "exportBytes": 1048576,
  "activeUsers": 6,
  "rateLimited": 0
}
```

## Daily document

Stored at `tenants/{tenantId}/usageDaily/{YYYY-MM-DD}` in Firestore.

| Field               | Type            | Notes                                                        |
| ------------------- | --------------- | ------------------------------------------------------------ |
| `tenantId`          | string          | Partition key.                                               |
| `date`              | string (date)   | UTC day; matches the doc id.                                 |
| `storageBytesDelta` | integer         | Net storage change for the day; may be negative.             |
| `imagesUploaded`    | integer ≥ 0     | Successful original uploads.                                 |
| `imagesProcessed`   | integer ≥ 0     | Derivative jobs completed.                                   |
| `signedUrlsIssued`  | integer ≥ 0     | Read/write signed URLs minted.                               |
| `editsApplied`      | integer ≥ 0     | Edit operations committed.                                   |
| `tagsApplied`       | integer ≥ 0     | Keyword tag mutations (`added + removed` per `photo.tagged`).|
| `apiCalls`          | integer ≥ 0     | Billable API requests.                                       |
| `storageBytesTotal` | integer \| null | Absolute storage at end-of-day; written by the snapshot job. |
| `updatedAt`         | string (date-time) | Last write timestamp.                                     |
| `shareEgressBytes`  | integer ≥ 0     | Bytes served through share links (issue #198). Increments on every de-duped `share.viewed` where `bytesServed` is known. |

## Where counters come from (event-to-counter mapping)

The rollup consumer subscribes to the **MeteringBus** and applies events to
the daily doc in a transaction (idempotent on `eventId`).

| Source event                                      | Counter             | Increment           |
| ------------------------------------------------- | ------------------- | ------------------- |
| `uploads.original.committed`                      | `imagesUploaded`    | +1                  |
| `uploads.original.committed`                      | `storageBytesDelta` | +bytes              |
| `originals.deleted`                               | `storageBytesDelta` | −bytes              |
| `derivatives.job.completed`                       | `imagesProcessed`   | +1                  |
| `derivatives.job.completed`                       | `storageBytesDelta` | +bytes              |
| `signing.url.issued`                              | `signedUrlsIssued`  | +1                  |
| `edits.operation.committed`                       | `editsApplied`      | +1                  |
| `photo.tagged`                                    | `tagsApplied`       | +(`added` + `removed`) |
| Any authenticated `/api/*` request                | `apiCalls`          | +1                  |
| `share.viewed` (deduped, issue #198)              | `shareEgressBytes`  | +`bytesServed`      |

> The MeteringBus interface ships ahead of its dedicated infrastructure
> issue. In local mode it is an in-memory bus; in Firebase mode it can be
> swapped for Pub/Sub without touching consumers.

## Daily storage snapshot

Once per day, the `scheduledStorageSnapshot` job iterates every tenant,
recomputes the absolute storage footprint using the same logic as
`/internal/storage-usage/:libraryId`, and writes the value onto that day's
doc as `storageBytesTotal`. This bounds drift from delta-only counters and
gives billing systems an authoritative number alongside per-day deltas.

The job is idempotent: re-running on the same day overwrites the snapshot
value but does not double-count the deltas.

## Push trigger: `metering.rollup.completed`

After each tenant's daily snapshot, the system emits one
`metering.rollup.completed` event:

```json
{
  "type": "metering.rollup.completed",
  "tenantId": "tenant-A",
  "date": "2026-04-12",
  "storageBytesTotal": 1234567890,
  "occurredAt": "2026-04-13T00:05:00.000Z"
}
```

Hosts can subscribe to this event to push-trigger their billing job
instead of polling the read endpoint.

## Push trigger: storage threshold webhooks (issue #196)

Hosts that resell AuraPix should not need to poll `GET /v1/tenants/:id/usage`
to know when one of their customer tenants is approaching its plan
limit. AuraPix pushes two webhook events on the existing host webhook
pipeline whenever a tenant's storage usage **crosses** or **clears** a
configured threshold:

| Event                                | Fires when                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `tenant.storage.threshold_crossed`   | Used bytes / quota bytes ≥ threshold for the first time since the last `_cleared`.       |
| `tenant.storage.threshold_cleared`   | Used bytes / quota bytes ≤ (threshold − 5%) after a `_crossed` event was previously fired. |

Payload (both events; only the trailing timestamp field differs):

```json
{
  "type": "tenant.storage.threshold_crossed",
  "tenantId": "tenant-A",
  "meta": {
    "tenantId": "tenant-A",
    "threshold": 0.8,
    "usedBytes": 8589934592,
    "quotaBytes": 10737418240,
    "crossedAt": "2026-06-30T12:00:00.000Z"
  }
}
```

### Hysteresis (no flapping)

A threshold fires `_crossed` **at most once per crossing direction**. After
`_crossed` is emitted, the threshold is considered "armed for clear";
`_cleared` only fires once usage has dropped by at least **5% of quota**
below the threshold and then crosses up again. This guarantees a tenant
that hovers around 80% does not generate a flood of webhook events.

State is persisted on the tenant doc (`storageThresholdState`) so a
restart never re-fires events for thresholds that were already crossed.

### Evaluation cadence

Evaluation is **piggy-backed** on existing hot paths — there is no new
scheduler:

| Trigger                 | What it can fire           |
| ----------------------- | -------------------------- |
| Successful upload       | `_crossed` (usage went up) |
| Trash purge job         | `_cleared` (usage went down) |

### Default thresholds

When a tenant has no per-tenant override, the system applies:

```json
[0.5, 0.8, 0.95, 1.0]
```

Values above `1.0` (up to `1.5`) are permitted on a per-tenant basis so
hosts can wire **overage** alerts (e.g. `1.05` = 5% over quota).

### Configure per-tenant thresholds

Manage the override via the per-tenant config API. Requires a host API
key with the `tenants.write` scope (read uses `tenants.read`); also
accessible to the tenant owner via the `/api/v1/...` prefix.

```
GET    /v1/tenants/{tenantId}/storage/thresholds
PUT    /v1/tenants/{tenantId}/storage/thresholds   body: { "thresholds": [0.5, 0.8, 0.95, 1.05] }
DELETE /v1/tenants/{tenantId}/storage/thresholds   (revert to defaults)
```

Response shape:

```json
{
  "tenantId": "tenant-A",
  "thresholds": [0.5, 0.8, 0.95, 1.05],
  "defaults": [0.5, 0.8, 0.95, 1.0],
  "override": [0.5, 0.8, 0.95, 1.05],
  "source": "tenant",
  "updatedAt": "2026-06-30T12:00:00.000Z"
}
```

Validation rules:

- 1–8 entries.
- Each entry must be a finite number in the open interval `(0, 1.5]`.
- Duplicates (after 3-decimal normalization) are deduped silently.
- Output is always sorted ascending.

### Discovery

Both events appear in the public catalog at
`GET /v1/host/webhook-events` (#176) so hosts can discover them
programmatically; their schemas live in `services/metering/eventCatalog.ts`.

## Caveats & dependencies

- The `tenantId` model and host API key scopes (`usage.read`) are tracked
  in their own issues. Until host keys land, only the **tenant owner**
  (mapped today as `tenantId == authenticated uid`) can read the endpoint.
- The Firestore-backed store for `usageDaily` ships alongside the
  Firebase mode wiring; local-dev uses an in-memory store with the same
  semantics for tests.
