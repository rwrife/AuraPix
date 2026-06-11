# Idempotency-Key Support

Hosts that integrate with AuraPix server-to-server need to retry mutating
requests safely on transient network failure. Without an idempotency
mechanism, a retried `POST` after a connection drop can create duplicate
albums, duplicate uploads, or double-charge metered actions when the host
reconciles billing downstream.

AuraPix supports the standard `Idempotency-Key` request header on a
focused allow-list of mutating endpoints, following the Stripe / IETF
`draft-ietf-httpapi-idempotency-key-header` conventions.

> Tracking issue: [#162](https://github.com/rwrife/AuraPix/issues/162).

## At a glance

| Behavior | Returned |
| --- | --- |
| First request with a key | Handler executes; response cached for 24h. Metering events emitted as normal. |
| Retry with same key + same body within TTL | **Cached response replayed.** Handler is NOT invoked, metering NOT re-emitted. Response carries `Idempotency-Replayed: true`. |
| Retry with same key + different body within TTL | `409 IDEMPOTENCY_KEY_CONFLICT`. |
| Retry after TTL expiry | Handler re-executes; cache is refreshed. |
| No `Idempotency-Key` header | Endpoint behaves exactly as before. |

## Header contract

```
Idempotency-Key: <opaque-string>
```

- Opaque, caller-chosen. UUIDv4 is the recommended format.
- ASCII, trimmed of surrounding whitespace, **case-preserved**.
- Maximum length **255 characters**. Longer keys are rejected with
  `400 INVALID_IDEMPOTENCY_KEY`.
- Empty / missing keys are treated as opt-out — the route runs normally.

Successful cached replays expose:

```
Idempotency-Replayed: true
```

This header is added to the CORS `Access-Control-Expose-Headers` list so
browser callers can read it from `fetch` responses.

## Scoping & isolation

Keys are scoped to the tuple `(tenantId, route, key)`. Cross-tenant
collisions are impossible because:

1. The persistent record id is `SHA-256(tenantId:route:key)`.
2. The verbatim `tenantId` is also written onto every record, so a single
   equality query can purge all of a tenant's idempotency rows during
   offboarding.

The `tenantId` is resolved per-request from:

1. `req.tenant.id` — when the call is authenticated with a host API key
   (`Authorization: Bearer ak_live_...`).
2. `req.user.uid` — when the call is authenticated by a Firebase user
   token (the legacy "user is their own tenant" mapping used elsewhere in
   the codebase).
3. Absent → the middleware passes through without dedup; the caller's key
   is effectively a no-op.

## Storage & TTL

Cached responses are persisted in the `idempotency_keys` collection with
the following shape:

```ts
type IdempotencyRecord = {
  key: string;
  tenantId: string;
  route: string;
  bodyHash: string;     // sha256 of canonicalized request body
  status: number;       // captured response status
  body: unknown | null; // captured JSON body (null for 204-style sends)
  headers: Record<string, string>; // small subset: content-type, location, etag
  createdAt: string;    // ISO-8601
  expiresAt: string;    // ISO-8601, createdAt + 24h
};
```

- **TTL is 24 hours.** The middleware checks `expiresAt` on every read; any
  record past its expiry is treated as a cache miss and the handler runs
  again. The check is authoritative even in environments where the storage
  backend does not enforce TTL natively.
- **Firebase production**: add a Firestore TTL policy on
  `idempotency_keys.expiresAt` so expired records are GC'd automatically.
  See `docs/features/security-compliance-observability.md` for the
  pattern used by other TTL collections.
- Only `2xx` responses are cached. `4xx`/`5xx` responses are NOT cached so
  a corrected retry payload can succeed without first invalidating the key.

## Conflict semantics (same key, different body)

The middleware hashes the request body with SHA-256 over a canonicalized
JSON form (object keys sorted alphabetically; arrays preserve order;
`undefined` properties dropped). Two requests that serialize to the same
canonical JSON produce the same hash.

If a retry arrives with the same key but a different hash, the response is:

```json
{
  "error": {
    "code": "IDEMPOTENCY_KEY_CONFLICT",
    "message": "Idempotency-Key reused with a different request body",
    "requestId": "<uuid>",
    "details": {
      "route": "POST /api/v1/albums",
      "key": "<caller-supplied>"
    }
  }
}
```

with HTTP `409 Conflict`. This protects callers from silently overwriting
or duplicating state when a client bug reuses keys across distinct
intents.

## Metering & billing protection

The whole point of idempotency is to avoid double-charging. Concretely:

- The original handler is the **only** codepath that emits metering events
  (`upload.accepted`, `image.processed`, `edit.applied`, …) for a given
  key. Cached replays bypass the handler entirely, so no metering event
  fires.
- On a cached replay, the middleware emits a single
  `idempotency.replayed` event:

  ```ts
  {
    tenantId: string,
    type: 'idempotency.replayed',
    count: 1,
    meta: { route: string, key: string }
  }
  ```

  This is a **debug-tier, NOT billable** event. Hosts should filter it
  out of billing rollups; it exists purely so operators can observe
  client retry behavior. See
  [`metering-events.md`](./metering-events.md) for the event catalog.

## Allow-listed endpoints

Idempotency is opt-in per route. The current allow-list covers the
mutating host-callable endpoints that are highest-risk for duplication:

| Route | Notes |
| --- | --- |
| `POST /api/v1/albums` | Create album. |
| `DELETE /v1/photos/{id}` *and* `DELETE /api/v1/photos/{id}` | Trash a photo (bulk photo op). |
| `POST /v1/photos/{id}/restore` *and* `POST /api/v1/photos/{id}/restore` | Restore a trashed photo. |

Routes pending implementation that will join the allow-list when they
land (acceptance criteria of issue #162):

- Photo upload commit (`functions/src/handlers/images/upload.ts`).
- Tenant user invite.
- Webhook signing-secret rotate.

To opt a new route in:

```ts
import { createIdempotencyMiddleware } from './middleware/idempotency.js';

app.post(
  '/api/v1/tenants/:tenantId/invitations',
  authMiddleware,
  createIdempotencyMiddleware({
    route: 'POST /api/v1/tenants/:tenantId/invitations',
    dataAdapter,
  }),
  handler,
);
```

The factory accepts a `resolveTenantId` override if the route needs a
different tenant resolution strategy than the default
`req.tenant?.id ?? req.user?.uid`.

## OpenAPI contracts

The `Idempotency-Key` request parameter and `Idempotency-Replayed`
response header are declared in:

- `contracts/openapi/albums.openapi.json` — bumped to `1.2.0`.
- `contracts/openapi/photos.openapi.json` — bumped to `1.1.0`.

Both files expose them as named components (`#/components/parameters/IdempotencyKey`
and `#/components/headers/IdempotencyReplayed`) so future routes can
reference them without duplication.

## Failure modes & guarantees

- **Store outage on lookup**: the middleware logs and proceeds to the
  handler. Behavior degrades to the pre-feature world (no dedup); it
  does NOT 500.
- **Store outage on write**: the response is still delivered to the
  caller; a retry within the TTL will re-execute the handler instead of
  replaying.
- **Response is non-2xx**: not cached. Callers can retry with a
  corrected body using the same key.
- **Race between two simultaneous first requests**: both may execute the
  handler; the last writer to the store wins. For strict
  "exactly-once" semantics under concurrent first requests, callers
  should serialize their retries. (Firestore transactional locking is a
  follow-up if real-world traffic shows this matters.)
