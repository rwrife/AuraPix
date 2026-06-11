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
per-tenant host API keys (#131) and the branding/tenant model (#149).

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

## Metering hooks

The CSP middleware and the violation report endpoint emit two reserved
metering event types onto the existing `MeteringBus`:

| Event                      | When                                                  | Debounce            |
| -------------------------- | ----------------------------------------------------- | ------------------- |
| `embed.session_started`    | An allowed parent frames an embed-eligible response   | 1 / min / tenant+origin |
| `embed.origin_blocked`     | Browser posts a `frame-ancestors` violation report    | None (report-driven) |

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
