# Feature Plan: Sharing & Access Control

## Objective
Enable secure internal and public sharing while protecting originals and access boundaries.

## Scope
- Share links with optional password and expiration
- Public and authenticated access modes
- Download permissions and watermark toggles
- Share revocation and activity monitoring

## Planned detail expansion
- Share token model and validation lifecycle
- Firestore + Storage Rules boundaries
- Rate limiting and abuse mitigation
- Audit events and incident response flow

## Per-share-link analytics (issue #198)

Every successful share-link resolution — both the HTML view and the
underlying signed media fetch — records a **view row** and emits the
billable `share.viewed` metering event. Tenants can pull a rollup for a
single link via a read-only endpoint.

### Endpoint

```
GET /v1/tenants/{tenantId}/share-links/{linkId}/analytics
```

- **Auth:** tenant owner (Bearer) **or** a host API key with the
  `usage.read` scope, tied to the same tenantId.
- **Read-only.** No mutations, no side effects.
- **Cross-tenant:** if the linkId belongs to a different tenant, the
  endpoint returns the empty-shape payload (never confirms existence
  of a foreign link).
- **Rate limiting:** honours the per-tenant rate limiter (#154).

### Response

```json
{
  "linkId": "link-1",
  "tenantId": "tenant-A",
  "totalViews": 42,
  "uniqueViewers": 17,
  "bytesServed": 8388608,
  "lastViewedAt": "2026-04-06T12:00:00.000Z",
  "last7DaysSeries": [
    { "date": "2026-04-01", "views": 0, "bytesServed": 0 },
    { "date": "2026-04-02", "views": 3, "bytesServed": 524288 },
    { "date": "2026-04-03", "views": 5, "bytesServed": 1048576 },
    { "date": "2026-04-04", "views": 7, "bytesServed": 1572864 },
    { "date": "2026-04-05", "views": 12, "bytesServed": 2097152 },
    { "date": "2026-04-06", "views": 15, "bytesServed": 3145728 },
    { "date": "2026-04-07", "views": 0, "bytesServed": 0 }
  ]
}
```

The 7-day series always contains exactly 7 entries in ascending UTC-day
order, ending on the current day. Days without views are zero-filled so
callers can render a sparkline without gap handling.

### View row storage

- Raw view rows are retained for **90 days**.
- Aggregate counters (`totalViews`, `uniqueViewers`, `bytesServed`,
  `lastViewedAt`) live on the share-link doc and persist **indefinitely**
  — hosts still see lifetime totals after raw rows age out.
- Rows and aggregates are tenant-scoped.

### De-duplication (60-second window)

A single page view typically fetches many sub-resources (the HTML plus
one media GET per photo). To avoid counting each GET as a separate view,
the tracker enforces a **60-second de-dup window** per
`(linkId, ipHash, uaHash)`:

- Only the **first** request in the window records a row and emits a
  billable `share.viewed` event.
- Subsequent requests within the window are treated as sub-resources of
  the same page load and do **not** increment counters.
- After 60 seconds elapse, the next request records a new view.

### `share.viewed` event

Emitted once per accepted (non-deduped) view:

```json
{
  "type": "share.viewed",
  "tenantId": "tenant-A",
  "resourceId": "link-1",
  "bytes": 65536,
  "meta": {
    "linkId": "link-1",
    "bytesServed": 65536,
    "referrerHost": "client.example.com",
    "grantType": "album"
  }
}
```

This is the canonical billable event. Hosts that prefer batch egress
billing instead of per-view can subscribe to `share.bandwidth.served`
which the daily rollup job emits per `(tenantId, linkId, date)`.

Both events are added to the webhook event catalog (#176).

### Privacy: IP and UA are HMAC-hashed per tenant

Raw view rows never store the caller's IP address or user-agent string.
Both are first HMAC-hashed with a **per-tenant secret**:

- `ipHash = HMAC(perTenantSecret, ip)`
- `uaHash = HMAC(perTenantSecret, userAgent)`

The per-tenant secret is derived deterministically from the master
signing secret + tenantId, so:

- The hash is stable across process restarts (dedup still works).
- The same raw IP under two different tenants produces two different
  hashes — tenants cannot correlate viewers across each other.
- The raw IP / UA never persists anywhere and cannot be recovered from
  the hash.

The `referrerHost` field stores only the host portion of the `Referer`
header (never the full URL / query string), so an origin cannot leak
query parameters that a viewer clicked from.
