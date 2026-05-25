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

Reserved for follow-ups (not emitted yet): `plugin.ran`, `user.active`,
`share.viewed`.

### Non-billable metadata writes (explicit exclusions)

Pure photo-metadata writes — such as the Lightroom-style triage fields
(`rating`, `flag`), favoriting, and tag edits — are deliberately **not**
emitted as metering events. In particular:

- `PATCH /v1/photos/:id { rating, flag }` (issue #141) MUST NOT emit
  `edit.applied`. That event is reserved for non-destructive image edits
  committed via `handlers/edits/applyEdits.ts` (a new version is written to
  storage and indexed). Triage updates only touch a small Firestore field set
  and do not produce a new derivative.
- The same exclusion applies to `isFavorite` toggles and `tags` updates.

If a host wants to bill culling activity, it can do so today by counting
photo writes in its own audit log; AuraPix will not double-count it as an
edit.

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
