# Metering Events & Host Webhook Fanout

AuraPix emits **metering events** at the points where billable work happens,
so a host application (the one reselling AuraPix to its customers) can drive
metered billing without polling.

This document describes the **event catalog**, the **transport** (a single
HMAC-signed webhook), and the **payload shape**.

> Tracking issue: [#130](https://github.com/rwrife/AuraPix/issues/130).

## Configuration

| Env var | Required | Description |
| --- | --- | --- |
| `HOST_METERING_WEBHOOK_URL` | no | When unset, metering is disabled (no-op sink). When set, batched events POST here. |
| `SIGNING_MASTER_SECRET` | yes (when webhook set) | Used for the HMAC signature header. Already used elsewhere for signed URLs. |

When `HOST_METERING_WEBHOOK_URL` is unset, emit calls are queued and
discarded; there is no outbound traffic.

## Event catalog (initial set)

All events share the shape:

```ts
type MeteringEvent = {
  tenantId: string;              // host-side routing key
  type: MeteringEventType;       // see table below
  count?: number;                // defaults to 1
  bytes?: number;                // when meaningful
  resourceId?: string;           // e.g. photoId / keyId
  occurredAt?: string;           // ISO-8601; server-stamped if missing
  meta?: Record<string, unknown>;// small, free-form
}
```

| `type` | Emitted from | Notable fields |
| --- | --- | --- |
| `upload.accepted` | `handlers/images/upload.ts` after the original image is stored | `count=1`, `bytes=metadata.sizeBytes`, `resourceId=photoId`, `meta.userId`, `meta.sourceType` |
| `image.processed` | `handlers/thumbnails/generate.ts` after derivatives are written | one event per derivative variant (7 today: small/medium/large × webp+jpeg + preview_jpeg), `resourceId=photoId`, `meta.stage='thumbnail'` |
| `signed_url.issued` | `routes/signing.ts` user and share grants | `resourceId=signingKey.keyId`, `meta.grantType='user'\|'share'` |
| `edit.applied` | `handlers/edits/applyEdits.ts` after a non-destructive edit version is committed | `resourceId=photoId`, `meta.version`, `meta.operationCount` |
| `quota.exceeded` | `handlers/images/upload.ts` when the in-process quota check rejects with HTTP 413 | `count=1`, `bytes=attemptedBytes`, `resourceId=userId`, `meta.libraryId`, `meta.usageBytes`, `meta.quotaBytes`, `meta.attemptedBytes` |
| `quota.warning` | `services/metering/storageSnapshot.ts` once per threshold per tenant per UTC day when usage crosses the configured fractions of quota | `bytes=usageBytes`, `meta.threshold` (e.g. `0.8`, `0.95`), `meta.quotaBytes`, `meta.usageBytes`, `meta.date` |
| `share.viewed` | `services/imageAuth/ImageAuthorizer.ts` after a share token passes auth, expiry, max-uses, and resource-scope checks (i.e. an access is actually granted; failed accesses are not counted) | `count=1`, `resourceId=shareLink.id`, `meta.photoId`, `meta.libraryId`, `meta.grantType='album'\|'photo'\|'library'` |
| `plugin.ran` | `handlers/edits/applyEdits.ts` once per edit operation in the recipe, on both success and failure | `count=1`, `resourceId=photoId`, `meta.pluginId`, `meta.durationMs`, `meta.success` |
| `photo.trashed` | `domain/photos/PhotosService.softDelete` (`DELETE /v1/photos/:id`) | `count=1`, `bytes=original.sizeBytes`, `resourceId=photoId`, `meta.libraryId`, `meta.actor`. Hosts that bill on "active storage" can decrement immediately; hosts that bill on "stored bytes" can ignore. |
| `photo.purged` | `jobs/purgeTrash.ts` after bytes are freed | `count=1`, **`bytes=-original.sizeBytes`** (negative), `resourceId=photoId`, `meta.libraryId`, `meta.trashedAt`. The daily `storageBytesDelta` rollup decrements on this event, not on `photo.trashed`. Emitted **exactly once** per photo. |
| `embed.session_started` | `routes/embedV1.ts` CSP middleware, when an allowed parent origin frames an embed-eligible response | `count=1`, `meta.origin`, `meta.userAgent`. Debounced to **max 1 per minute per (tenantId, origin)** so high-traffic embeds don't flood the bus. See `docs/features/embed-handshake.md`. |
| `embed.origin_blocked` | `routes/embedV1.ts` CSP `report-uri` endpoint, on a browser-posted `frame-ancestors` violation | `count=1`, `meta.blockedUri`, `meta.documentUri`, `meta.violatedDirective`. Helps hosts find misconfigured deployments. |
| `photo.tagged` | `domain/photos/PhotosService.updateTags` (`POST /v1/photos/:id/tags`) | `count=1`, `resourceId=photoId`, `meta.libraryId`, `meta.actor`, `meta.added`, `meta.removed`. Emitted **once per mutation**, not once per tag, so a photographer tagging 30 photos with 5 keywords each produces 30 events rather than 150. Drives the `tagsApplied` daily counter (sum of `added + removed`). |
| `photo.exported` | `routes/photoExportV1.ts` after a successful `POST /v1/photos/:id/export` (issue #174) | `count=1`, `bytes=outputBytes`, `resourceId=photoId`, `meta.libraryId`, `meta.preset`, `meta.outputWidth`, `meta.outputHeight`, `meta.cacheHit`, `meta.actor`. Emitted on both cache hits and misses (hosts may choose to discount `cacheHit:true` events at billing time). Drives the daily `exportBytes` counter (rendered bandwidth, billable). |
| `smart_album.created` | `domain/smartAlbums/SmartAlbumsService.create` (`POST /smart-albums`) | `count=1`, `resourceId=smartAlbumId`, `meta.libraryId`. |
| `smart_album.deleted` | `domain/smartAlbums/SmartAlbumsService.remove` (`DELETE /smart-albums/:id`) | `count=1`, `resourceId=smartAlbumId`, `meta.libraryId`. |
| `smart_album.materialized` | `domain/smartAlbums/SmartAlbumsService.materialize` (`GET /smart-albums/:id/photos`) | `count=1`, `resourceId=smartAlbumId`, `meta.libraryId`, `meta.resultCount`, `meta.totalCount`. Hosts can use `resultCount` to detect heavy query patterns. |

Reserved for follow-ups (not emitted yet): `user.active`.

### Quota warning thresholds

Thresholds default to `[0.8, 0.95]` (80% and 95%). Override with the
env var `TENANT_QUOTA_WARNING_THRESHOLDS` as a comma-separated list of
fractions strictly between 0 and 1 (e.g. `0.5,0.75,0.9`). Each threshold
fires at most once per tenant per UTC day; the daily rollup doc tracks
the set of already-emitted thresholds in `quotaWarningsEmitted`.

## Tenant resolution

AuraPix does not yet have a first-class `tenantId` on every request (tracked
separately). Until that lands, emit sites use the helper
`resolveTenantId({ tenantId?, libraryId? })`, which returns the first
non-empty of:

1. an explicit `tenantId`
2. `lib:<libraryId>` (stable, scoped fallback)
3. `lib:unknown` (last resort)

This means hosts can already partition usage by library today, and the
payload shape will not change when a true `tenantId` is wired in.

## Transport: batched POST

Events are buffered by an in-memory bus and flushed when the **first** of
these triggers fires:

- 50 events queued, or
- 1 second since the oldest queued event

The bus POSTs a JSON envelope to `HOST_METERING_WEBHOOK_URL`:

```json
{
  "version": "v1",
  "sentAt": "2025-01-01T00:00:00.000Z",
  "events": [
    {
      "tenantId": "lib:abc123",
      "type": "upload.accepted",
      "count": 1,
      "bytes": 4823718,
      "resourceId": "ph_9XaR...",
      "occurredAt": "2025-01-01T00:00:00.000Z",
      "meta": { "userId": "u_42", "sourceType": "raster" }
    }
  ]
}
```

### Signature scheme

Each request carries:

```
X-AuraPix-Signature: v1=<hex(hmac_sha256(SIGNING_MASTER_SECRET, raw_body))>
```

- The version prefix (`v1=`) allows future rotation without breaking
  consumers.
- The MAC is computed over the **exact raw request body** (no canonicalization
  beyond JSON.stringify on our side). Hosts MUST verify against the raw bytes.
- Hosts SHOULD reject requests where the signature does not match or where
  `version` is unrecognized.

### Retry and drop policy

- Each batch is attempted up to **3 times** with exponential backoff
  (base 200 ms, doubling).
- Both non-2xx responses and request errors trigger a retry.
- On exhaustion the batch is **dropped** and an error is logged. We **never**
  block the originating request path on webhook delivery.
- Hosts are expected to be idempotent on `resourceId` + `type` +
  `occurredAt` to tolerate at-least-once delivery (though current policy is
  at-most-3 attempts).

## Failure modes

| Situation | Behaviour |
| --- | --- |
| `HOST_METERING_WEBHOOK_URL` unset | NoopMeteringSink; emits are dropped silently. |
| Webhook 5xx/timeout | Retried with backoff; dropped after 3 attempts. |
| `emit()` called during high load | Bus continues to buffer; if a batch is in flight, additional events accumulate for the next flush. |
| Process exits with pending events | Best-effort `shutdown()` flush at the call site; otherwise events in memory are lost (acceptable for usage telemetry). |

## Delivery observability (issue #144)

Metering POSTs are fire-and-forget by default, which makes it hard for hosts
to know *what* failed during an outage of their billing service. To close that
gap, every POST attempt records a **delivery record** scoped under the tenant:

```
tenants/{tenantId}/webhookDeliveries/{batchId}
```

Record shape:

```ts
type WebhookDeliveryRecord = {
  batchId: string;            // also the Firestore doc id
  tenantId: string;
  sentAt: string;             // ISO-8601 of first attempt
  statusCode: number | null;  // last observed HTTP status, null on network err
  ok: boolean;                // statusCode is 2xx
  attemptCount: number;       // number of attempts so far
  eventCount: number;         // events in the batch
  contentHash: string;        // sha256(raw body); NO body is persisted
  status: 'pending' | 'ok' | 'failed';
  errorMessage?: string;      // truncated to 500 chars
  updatedAt: string;          // ISO-8601 of last attempt
  expiresAt: string;          // Firestore TTL anchor (sentAt + 30d)
};
```

**No event bodies are stored** (privacy + cost). The `contentHash` field is
enough to correlate a record with a known payload; if the host needs the
raw events for a failed batch they can also derive them from the daily
rollup window.

Every POST attempt — success or failure — updates the same record (one row
per batch, not per attempt). Records are auto-purged by a Firestore TTL
policy on `expiresAt` after **30 days**.

Each outbound POST also carries an `X-AuraPix-Idempotency-Key: <batchId>`
header so the host can dedupe across automatic retries *and* manual
replays.

### Endpoints

Both endpoints require a host API key (`Authorization: Bearer ak_live_...`)
with the `webhooks.write` scope, scoped to the tenant in the URL.
Cross-tenant calls return 403.

#### `GET /api/v1/tenants/:tenantId/webhooks/deliveries`

Returns paginated delivery records, newest first.

| Query param | Type | Description |
| --- | --- | --- |
| `status` | `pending`\|`ok`\|`failed` | Filter by current status. |
| `since` | ISO-8601 | Inclusive lower bound on `sentAt`. |
| `limit` | int | Page size (default 50, max 200). |
| `cursor` | string | `nextCursor` from a previous response. |

Response:

```json
{
  "tenantId": "acme",
  "items": [ { "...": "WebhookDeliveryRecord" } ],
  "nextCursor": "b_9a2f..."
}
```

#### `POST /api/v1/tenants/:tenantId/webhooks/deliveries/:batchId:replay`

Re-sends a previously-attempted batch. The replayed POST reuses the same
`batchId` (and therefore the same `X-AuraPix-Idempotency-Key`), so a
well-behaved host endpoint will not double-count.

Response on success:

```json
{
  "tenantId": "acme",
  "batchId": "b_9a2f...",
  "replayed": true,
  "delivery": { "...": "WebhookDeliveryRecord (updated)" }
}
```

Important behaviors:

- The existing delivery record is updated in place — there is **no duplicate
  row** per replay.
- Concurrent replay calls for the same `batchId` are coalesced: the second
  call returns immediately without issuing a second POST (in-flight
  idempotency window).
- The raw batch body is reconstructed from a small in-process cache (default
  capacity 256 batches). Once the cache evicts a batch, replay returns
  `410 BATCH_BODY_EXPIRED`. Hosts that need a guaranteed long replay
  window can instead derive a fresh batch from the daily rollup.
- A separate `webhook.delivery_failed` metric event may be emitted after
  the in-process retries exhaust (planned follow-up; not required for the
  initial implementation).

