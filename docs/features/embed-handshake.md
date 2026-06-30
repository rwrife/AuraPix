# Embed Handshake

AuraPix is designed to be embedded inside host applications. This document
specifies the contract host pages can rely on:

1. **Allowed-origins config** — per-tenant list of origins permitted to
   iframe AuraPix. Enforced via the `Content-Security-Policy:
   frame-ancestors` and `X-Frame-Options` response headers.
2. **`postMessage` handshake** — a small typed protocol the embedded UI
   and the host page use to coordinate (ready, theme, navigation, resize,
   user events).
3. **Host SDK** — a dependency-free ESM helper (`src/embed/host-sdk.ts`)
   that wraps the protocol so hosts don't have to hand-roll
   `addEventListener('message', ...)` plumbing.

Issue: [#163](https://github.com/rwrife/AuraPix/issues/163). Depends on the
per-tenant host API keys (#131) and the branding/tenant model (#149). The
higher-level drop-in `@aurapix/embed` SDK (`packages/embed-sdk/`) is
tracked in [#177](https://github.com/rwrife/AuraPix/issues/177) and wraps
this contract for the common case.

## Allowed-origins configuration

### Endpoints

All embed admin endpoints are mounted under both
`/api/v1/tenants/:tenantId/embed/*` (in-product callers, also accepts a
Firebase user token) and `/v1/tenants/:tenantId/embed/*` (host-facing spec
URL). Mutating calls require a per-tenant host API key carrying the
`tenants.write` scope.

#### `GET /v1/tenants/:tenantId/embed/allowed-origins`

Returns the current allow-list. Requires `tenants.write` (since the topology
itself is sensitive).

```json
{
  "embed": {
    "tenantId": "acme",
    "allowedOrigins": ["https://app.acme.com", "https://staging.acme.com"],
    "updatedAt": "2025-06-11T00:00:00.000Z"
  }
}
```

For a tenant that has never enabled embedding, `allowedOrigins` is `[]` —
embedding is **disabled by default** and the server responds with
`Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options:
DENY` on embed-eligible routes.

#### `PUT /v1/tenants/:tenantId/embed/allowed-origins`

Replaces the allow-list. Idempotent.

```bash
curl -X PUT https://api.aurapix.com/v1/tenants/acme/embed/allowed-origins \
  -H "Authorization: Bearer ak_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "origins": ["https://app.acme.com", "https://staging.acme.com"]
  }'
```

| Constraint                  | Notes                                                             |
| --------------------------- | ----------------------------------------------------------------- |
| Max origins per tenant      | 50                                                                |
| Each entry must be          | `scheme://host[:port]` — no path, query, fragment, userinfo       |
| Allowed schemes             | `https` always; `http` only for loopback hosts (localhost dev)    |
| Wildcards / patterns        | **Not** supported. Origins are inlined into `frame-ancestors`     |
| Empty list (`origins: []`)  | Disables embedding entirely                                       |
| Header-injection characters | Quoted strings, `;`, CR/LF, etc. are rejected with HTTP 400       |

Submitting a different list is a non-breaking change for clients already
embedded — the next page load picks up the new CSP header.

#### `POST /v1/tenants/:tenantId/embed/csp-report`

Browsers post `frame-ancestors` violation reports here (configured via the
`report-uri` directive emitted alongside the CSP). When a violation is
received, AuraPix emits the metering event `embed.origin_blocked` so hosts
can find mis-deployed integrations. **No auth required** — the body is
treated as untrusted.

### Per-request CSP enforcement

For any tenant-scoped request (path matches `/(api/v1|v1)/tenants/:tenantId/…`,
or the `X-AuraPix-Tenant-Id` header is set) the server attaches:

```
Content-Security-Policy: frame-ancestors https://app.acme.com https://staging.acme.com; report-uri /api/v1/tenants/acme/embed/csp-report
```

When the allow-list is empty:

```
Content-Security-Policy: frame-ancestors 'none'
X-Frame-Options: DENY
```

When the allow-list has exactly one entry, `X-Frame-Options: SAMEORIGIN`
is also emitted (older browsers ignore `frame-ancestors`).

## `postMessage` contract

All messages are JSON-serializable objects with a discriminator field
`type` starting with the prefix `aurapix:`. Both sides MUST validate
`event.origin` against the allow-list and ignore any message whose `data`
shape doesn't match below.

### Embedded → Host

| `type`             | Payload                            | When emitted                                             |
| ------------------ | ---------------------------------- | -------------------------------------------------------- |
| `aurapix:ready`    | `{ tenantId, version }`            | Immediately after the embedded UI mounts                 |
| `aurapix:resize`   | `{ height }` (CSS px)              | When the content height changes (ResizeObserver)         |
| `aurapix:event`    | `{ name, payload? }`               | Select user actions (`selection-changed`, `upload-started`, …) |

### Host → Embedded

| `type`              | Payload         | Semantics                                  |
| ------------------- | --------------- | ------------------------------------------ |
| `aurapix:set-theme` | `{ theme }`     | `light` \| `dark` \| `system` \| `<custom>` |
| `aurapix:navigate`  | `{ path }`      | Path starts with `/`; routes inside AuraPix |
| `aurapix:session`   | `{ token }`     | Forward a host-issued embed session token (SSO). See [Host-issued session tokens](#host-issued-session-tokens-sso) |

### Origin / source validation

Both sides MUST:

- Drop any `MessageEvent` whose `event.origin` is not in the tenant's
  allow-list (host side) or whose origin is not the iframe's origin
  (embedded side).
- Drop messages whose `event.source` is not the expected window
  (`iframe.contentWindow` for the host, `window.parent` for the embedded
  app). This defends against sibling iframes and `window.opener` spoofing.
- Never use `'*'` as the `targetOrigin` argument to `postMessage`.

### Versioning

The handshake message types are append-only. New `aurapix:event` names are
free; new top-level `type` values are minor-version additions and existing
ones MUST keep the same payload shape. The `version` carried in
`aurapix:ready` lets hosts adapt UI affordances to the embedded build.

## Host SDK usage

```ts
import { createEmbedHost } from '@aurapix/host-sdk';

const iframe = document.querySelector('iframe#aurapix') as HTMLIFrameElement;
const host = createEmbedHost({
  iframe,
  targetOrigin: 'https://app.aurapix.com',
});

const off = host.on((msg) => {
  switch (msg.type) {
    case 'aurapix:ready':
      console.log(`AuraPix ${msg.version} ready for tenant ${msg.tenantId}`);
      host.setTheme(document.documentElement.dataset.theme ?? 'system');
      break;
    case 'aurapix:resize':
      iframe.style.height = `${msg.height}px`;
      break;
    case 'aurapix:event':
      console.log('AuraPix event:', msg.name, msg.payload);
      break;
  }
});

// Later — switch theme or deep-link.
host.setTheme('dark');
host.navigate('/photos/abcd1234');

// Tear down before unmount.
off();
host.dispose();
```

The SDK enforces all of the origin/source checks above and throws on
configuration mistakes (`'*'`, missing or malformed `targetOrigin`).

## Host-issued session tokens (SSO)

_Tracking issue: [#195](https://github.com/rwrife/AuraPix/issues/195)._

When AuraPix is embedded inside a host application, end users have
already authenticated with the host. Showing them a second Firebase login
prompt breaks the illusion of a seamless host-branded experience. The
embed session-token flow lets the host backend mint a short-lived signed
credential that the embedded UI exchanges for a server-side session.

### Mint a token (host backend)

`POST /v1/tenants/{tenantId}/embed/session-tokens` — host-API-key
authenticated with the `tenants.write` scope.

Request body:

```json
{
  "userId": "u_42",
  "role": "editor",      // optional, defaults to the membership role
  "ttlSeconds": 120      // optional, capped at 300, defaults to 120
}
```

Response `201`:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.<payload>.<sig>",
  "expiresAt": "2026-06-29T16:21:00.000Z",
  "audience": "aurapix:embed"
}
```

The `userId` MUST already be a member of the tenant (provision via
`POST /v1/tenants/{tenantId}/users` first). If not, the call returns
`409 user_not_member` and the host must call the tenant-users API before
retrying. Auto-provisioning from the embed flow is intentionally out of
scope.

### Token shape

Compact JWT signed with HS256 using the tenant's existing webhook
signing secret (issue #161 — the dual-secret rotation grace window is
honoured at verification time). Claims:

| Claim   | Value                                  |
| ------- | -------------------------------------- |
| `iss`   | `tenantId`                             |
| `aud`   | `aurapix:embed`                        |
| `sub`   | `userId`                               |
| `role`  | `owner` \| `editor` \| `viewer`        |
| `jti`   | UUID — one-time-use within the TTL     |
| `iat`   | unix seconds                           |
| `exp`   | unix seconds (`exp - iat ≤ 300`)       |

### Forward over postMessage

The host SDK accepts a `sessionToken` option on `createEmbedHost`:

```ts
import { createEmbedHost } from '@aurapix/embed-sdk'; // or src/embed/host-sdk.ts

const handle = createEmbedHost({
  iframe,
  targetOrigin: 'https://app.aurapix.com',
  sessionToken,            // minted above
});
```

The SDK queues the token internally and forwards it as the first
`postMessage` after the embedded UI announces `aurapix:ready`:

```json
{ "type": "aurapix:session", "token": "<jwt>" }
```

Callers can also set/replace the token after mount via
`handle.sendSessionToken(token)`.

### Exchange (embedded side)

`POST /v1/tenants/{tenantId}/embed/session-exchange` — the token IS the
credential, so no Authorization header is required. Body: `{ token }`.

The server validates:

- Signature against the tenant's current and (within the grace window)
  previous webhook signing secret.
- `aud === "aurapix:embed"`.
- `iss === tenantId` from the URL path. Cross-tenant tokens are rejected
  with `403 tenant_mismatch` so a token minted by tenant A can never be
  relayed into tenant B's embed.
- `exp` (with a 30s skew window).
- `jti` has not been redeemed before — second redemption returns
  `401 token_replayed`.
- The user is still a member of the tenant — revoked users get
  `409 user_not_member`.

On success the response is:

```json
{
  "tenantId": "acme",
  "userId": "u_42",
  "role": "editor",
  "expiresAt": "2026-06-29T16:21:00.000Z",
  "session": { ... }   // optional opaque payload (e.g. Firebase custom token)
}
```

Deployments wire `issueEmbedSession` on the router so the `session`
field can carry a Firebase custom token; the embedded SDK then signs in
with `signInWithCustomToken` and no Firebase login UI is shown.

### Allowed-origins still enforced

The session-token flow does **not** bypass the per-tenant allowed-origins
config (#163). The CSP `frame-ancestors` header is still emitted from the
stored allow-list; a valid token cannot frame AuraPix from an origin the
tenant hasn't approved.

### Metering

- `embed.session.minted` — emitted by the mint endpoint. Useful for
  hosts that bill per session (`meta.userId`, `meta.role`,
  `meta.ttlSeconds`, `meta.jtiHash`).
- `embed.session.exchanged` — emitted by the exchange endpoint. The
  meaningful "active embedded user" signal; complements `user.active`
  with embed context (`meta.userId`, `meta.role`, `meta.jtiHash`,
  `meta.matchedSecret`).

The `jtiHash` is the first 16 hex characters of `sha256(jti)` — stable
for correlation but non-reversible.

## Metering hooks

The CSP middleware, the violation report endpoint, and the embed-SDK
session-end beacon emit three reserved metering event types onto the
existing `MeteringBus`:

| Event                      | When                                                                                       | Debounce            |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------------------- |
| `embed.session_started`    | An allowed parent frames an embed-eligible response                                        | 1 / min / tenant+origin |
| `embed.session_ended`      | The `@aurapix/embed` SDK posts to `POST /v1/tenants/:id/embed/session-end` on `destroy()` or `pagehide` (issue #177) | None (client-driven) |
| `embed.origin_blocked`     | Browser posts a `frame-ancestors` violation report                                         | None (report-driven) |

Hosts can correlate these with their active-user billing by subscribing
through the standard host webhook fanout (see `metering-events.md`).

## Acceptance-criteria mapping

| Criterion                                                                | Implementation                                            |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| `PUT/GET /v1/tenants/:id/embed/allowed-origins` host-API-key gated       | `functions/src/routes/embedV1.ts` + server.ts wiring      |
| CSP `frame-ancestors` header emitted per tenant on embed routes          | `createEmbedCspMiddleware` (mounted on `/api/v1`, `/v1`)  |
| Documented postMessage event schema                                      | This document                                              |
| `src/embed/host-sdk.ts` with TypeScript types and unit tests             | `src/embed/host-sdk.ts`, `src/embed/contract.ts`, tests   |
| Embedded UI ignores messages from non-allowed origins (tested)           | `src/embed/embedded.ts` + `src/embed/host-sdk.test.ts`    |
| `embed.session_started` flows through existing bus                       | `MeteringBus` event type + middleware emit                |
| OpenAPI updated                                                          | `contracts/openapi/embed.openapi.json`                    |
| `POST /v1/tenants/:id/embed/session-tokens` minted JWT, host-API-key gated (#195) | `functions/src/services/host/embedSessionTokenService.ts` + `embedV1.ts` route |
| Replay defense (`token_replayed`) via single-use `jti` tracking (#195)   | `embedSessionTokenJtis` collection + `verifyAndRedeemEmbedSessionToken` |
| Cross-tenant tokens rejected at exchange time (#195)                     | `iss` claim vs URL `tenantId` check in the exchange route |
| `embed.session.minted` / `embed.session.exchanged` events catalogued (#195) | `functions/src/services/metering/eventCatalog.ts`        |
