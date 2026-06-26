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
activeUsers, rateLimited, storageBytesTotal, updatedAt
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
tenantId,date,storageBytesDelta,imagesUploaded,imagesProcessed,signedUrlsIssued,editsApplied,tagsApplied,apiCalls,exportBytes,activeUsers,rateLimited,storageBytesTotal,updatedAt
tenant-A,2026-04-01,0,0,0,0,0,0,4,0,0,0,,2026-04-02T10:00:00.000Z
tenant-A,2026-04-02,1024,2,0,0,0,0,0,0,0,0,,2026-04-02T10:00:00.000Z
tenant-A,2026-04-03,0,0,0,0,0,0,0,0,0,0,,1970-01-01T00:00:00.000Z
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

## Caveats & dependencies

- The `tenantId` model and host API key scopes (`usage.read`) are tracked
  in their own issues. Until host keys land, only the **tenant owner**
  (mapped today as `tenantId == authenticated uid`) can read the endpoint.
- The Firestore-backed store for `usageDaily` ships alongside the
  Firebase mode wiring; local-dev uses an in-memory store with the same
  semantics for tests.
