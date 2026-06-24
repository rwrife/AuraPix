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

## Event catalog

<!-- EVENT_CATALOG:BEGIN -->

> ⚠️ This table is auto-generated from `functions/src/services/metering/eventCatalog.ts`.
> Do not hand-edit; run `node scripts/generate-event-catalog-docs.mjs` after changing the registry.
>
> **Catalog version:** `2026-06-20` — the same string is stamped on every outbound webhook envelope and returned by `GET /v1/host/webhook-events`.

| `type` | Version | Billable | Description |
| --- | --- | --- | --- |
| `upload.accepted` | 1 | ✅ | Original image stored after a successful upload. One event per photo. |
| `image.processed` | 1 | ✅ | A derivative variant (thumbnail / preview) was written. One event per variant. |
| `signed_url.issued` | 1 | ✅ | A signed URL was minted for a user or share grant. |
| `edit.applied` | 1 | ✅ | A non-destructive edit version was committed for a photo. |
| `bulk.batch` | 1 | ✅ | A `POST /v1/photos:batch` call completed. One event per call regardless of N. |
| `user.active` | 1 | ✅ | First end-user request of the UTC day for `(tenantId, userId)`. The per-seat billing signal. |
| `user.provisioned` | 1 | — | A new tenant membership was created. |
| `user.revoked` | 1 | — | A tenant membership was removed. |
| `quota.exceeded` | 1 | — | In-process storage quota check rejected an upload with HTTP 413. |
| `quota.warning` | 1 | — | Tenant storage usage crossed a configured threshold (e.g. 80%, 95%). Once per threshold per UTC day. |
| `share.viewed` | 1 | ✅ | A share token passed auth and a resource was actually delivered. |
| `plugin.ran` | 1 | ✅ | A plugin/edit operation executed (success or failure). One event per operation. |
| `plugin.enabled` | 1 | — | A tenant toggled a plugin to enabled. |
| `plugin.disabled` | 1 | — | A tenant toggled a plugin to disabled. |
| `plugin.blocked` | 1 | — | An edit operation referenced a plugin not in the tenant allowlist. |
| `photo.trashed` | 1 | — | A photo was soft-deleted (moved to trash). |
| `photo.purged` | 1 | — | A trashed photo was permanently purged and its bytes freed. `bytes` is negative. |
| `photo.tagged` | 1 | — | A photo had tags, rating, flag, or color label changed. One event per mutation, not per tag. Issue #184 added `meta.kind` to disambiguate (`tag` \| `rating` \| `flag` \| `colorLabel`). |
| `photo.exported` | 1 | ✅ | A photo was successfully exported (cache hit or miss). Drives the `exportBytes` rollup. Issue #185 added `meta.watermark` (boolean) to distinguish watermarked vs clean exports. |
| `audit.queried` | 1 | — | The host audit-events API was queried. |
| `tenant.export.requested` | 1 | — | A tenant data export was initiated via the offboarding API. |
| `tenant.export.completed` | 1 | — | A tenant data export finished and the bundle is available. |
| `tenant.deleted` | 1 | — | A tenant was hard-deleted. After this event, no further events for the tenant should fire. |
| `embed.session_started` | 1 | — | An allowed parent origin framed an embed-eligible response. Debounced per `(tenantId, origin)`. |
| `embed.session_ended` | 1 | — | The embed SDK reported a session end via the beacon endpoint or page unload. |
| `embed.origin_blocked` | 1 | — | A browser-reported `frame-ancestors` CSP violation. Helps hosts find misconfigured deployments. |
| `idempotency.replayed` | 1 | — | Idempotency-Key middleware served a cached response. Debug-tier; NOT billable. |
| `webhook.secret_rotated` | 1 | — | A tenant rotated its webhook signing secret. |
| `smart_album.created` | 1 | — | A smart album definition was created. |
| `smart_album.deleted` | 1 | — | A smart album definition was deleted. |
| `smart_album.materialized` | 1 | ✅ | A smart album was materialized via `GET /smart-albums/:id/photos`. |
| `feature.gated` | 1 | — | A request was rejected because a per-tenant feature flag is disabled. Hosts surface upsell. |
| `feature.flag_changed` | 1 | — | A host toggled a per-tenant feature flag. Audit / change-history signal. |

For the full JSON Schema of each event's `meta` payload, call
`GET /v1/host/webhook-events` with a host API key (see
`contracts/openapi/host-webhook-events.openapi.json`).

<!-- EVENT_CATALOG:END -->

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

