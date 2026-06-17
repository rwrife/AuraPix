# `@aurapix/embed`

Drop-in iframe loader + postMessage client for embedding AuraPix in a host
application.

- **~1–2 KB gzipped**, zero runtime dependencies
- ESM + CJS + TypeScript declarations
- Strictly client-side — the host's backend mints the user JWT
- Origin-validated postMessage handshake (issue
  [#163](https://github.com/rwrife/AuraPix/issues/163))

Tracking issue:
[#177](https://github.com/rwrife/AuraPix/issues/177).

## Install

> **Note:** this package lives in the AuraPix monorepo today and will be
> published to npm in a follow-up. Until then, integrators can vendor the
> bundle out of `packages/embed-sdk/dist/`.

```bash
npm install @aurapix/embed
```

## Quickstart

```html
<div id="aurapix-host" style="width: 100%; height: 600px;"></div>

<script type="module">
  import { mountAuraPix } from '@aurapix/embed';

  // The JWT is minted server-side by the host backend (see below). The SDK
  // is given an already-signed token; it never sees the host API key.
  const userJwt = await fetch('/api/aurapix/mint-user-jwt', {
    method: 'POST',
    body: JSON.stringify({ aurapixUserId: 'usr_42' }),
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
  }).then((r) => r.text());

  const handle = mountAuraPix(document.getElementById('aurapix-host'), {
    tenantId: 'tnt_123',
    userJwt,
    libraryId: 'lib_abc',
    theme: 'auto',
    aurapixOrigin: 'https://app.aurapix.com',
    onReady: ({ tenantId, version }) => {
      console.log(`AuraPix v${version} ready for ${tenantId}`);
    },
    onError: (err) => console.error(err.code, err.message),
    onEvent: (evt) => console.log('aurapix event:', evt),
  });

  // Imperative API
  handle.openPhoto('photo_xyz');
  handle.openAlbum('alb_42');
  handle.setTheme('dark');

  // Subscribe to specific event names emitted by the embed
  const unsub = handle.on('selection-changed', (payload) => {
    console.log('selection changed:', payload);
  });

  // Tear down — fires the `embed.session_ended` beacon and removes the
  // iframe. Safe to call multiple times.
  // unsub(); handle.destroy();
</script>
```

## Public API

### `mountAuraPix(hostElement, options) → handle`

| Option               | Type                                            | Default                            | Notes                                                                                                  |
| -------------------- | ----------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `tenantId`           | `string` _(required)_                           | —                                  | Mismatch with the JWT claims → backend rejects the session.                                            |
| `userJwt`            | `string` _(required)_                           | —                                  | Signed by the host backend. Passed in the URL fragment so it never reaches server logs.                |
| `libraryId`          | `string`                                        | —                                  | Pre-selects a library at mount.                                                                        |
| `theme`              | `'light' \| 'dark' \| 'auto' \| string`         | —                                  | Forwarded to the embed.                                                                                |
| `aurapixOrigin`      | `string`                                        | `'https://app.aurapix.com'`        | Exact origin; never `'*'`. Override for dev (`http://localhost:5173`).                                  |
| `embedUrl`           | `string`                                        | `${aurapixOrigin}/embed`           | For non-default embed routes / staging.                                                                |
| `handshakeTimeoutMs` | `number`                                        | `5000`                             | `onError` fires with `code: 'handshake_timeout'` if no `aurapix:ready` arrives in time.                |
| `onReady`            | `({ tenantId, version, origin }) => void`       | —                                  | Fires once on successful handshake.                                                                    |
| `onError`            | `(AuraPixError) => void`                        | —                                  | Typed errors. `code` is one of `invalid_element`, `invalid_origin`, `invalid_options`, `handshake_timeout`, `destroyed`. |
| `onEvent`            | `({ name, payload }) => void`                   | —                                  | Catch-all for every forwarded `aurapix:event`.                                                          |
| `sandbox`            | `string \| null`                                | conservative default               | Set to `null` to omit the `sandbox` attribute entirely.                                                |
| `allow`              | `string`                                        | _(unset)_                          | Permissions Policy applied to the iframe.                                                              |

### `handle`

| Member                       | Purpose                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `handle.iframe`              | The `HTMLIFrameElement` the SDK created.                                                         |
| `handle.openPhoto(id)`       | Navigate the embed to `/photos/:id`.                                                             |
| `handle.openAlbum(id)`       | Navigate the embed to `/albums/:id`.                                                             |
| `handle.setTheme(theme)`     | Switch theme without remount.                                                                    |
| `handle.on(event, handler)`  | Subscribe to a named event (`'ready'`, `'error'`, `'resize'`, or any forwarded `aurapix:event` name). Returns an unsubscribe function. |
| `handle.destroy()`           | Detach listeners, fire the `embed.session_ended` beacon, remove the iframe. Idempotent.          |

## Security model

- **Origin gate** — inbound `postMessage` events are only accepted when
  `event.origin === aurapixOrigin` _and_ `event.source ===
  iframe.contentWindow`. Spoofed messages from other iframes / tabs are
  silently dropped.
- **No API key in the browser** — the SDK only receives a per-user JWT.
  The host's API key (issue
  [#131](https://github.com/rwrife/AuraPix/issues/131)) stays on the host
  backend.
- **JWT in the URL fragment** — `userJwt` is passed via `location.hash`
  so it is never sent in the HTTP request line, server logs, or `Referer`
  headers.
- **Tenant mismatch** — if the embed's `aurapix:ready` reports a different
  `tenantId` than the SDK was configured for, `onError` fires with
  `code: 'invalid_options'`.

## Minting the user JWT (host backend snippet)

The SDK never sees the host API key. Mint the per-user JWT server-side and
return it to the browser through a host-owned endpoint.

```ts
// host backend — e.g. Express / Next.js API route
import crypto from 'node:crypto';

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function mintAuraPixUserJwt(opts: {
  hostApiKey: string;   // ak_live_…  (NEVER leaves the backend)
  tenantId: string;
  userId: string;
  ttlSeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: 'host',
      sub: opts.userId,
      aud: 'aurapix',
      tenantId: opts.tenantId,
      iat: now,
      exp: now + (opts.ttlSeconds ?? 5 * 60), // short-lived
    })
  );
  const sig = base64url(
    crypto
      .createHmac('sha256', opts.hostApiKey)
      .update(`${header}.${payload}`)
      .digest()
  );
  return `${header}.${payload}.${sig}`;
}
```

> The exact JWT format is the contract AuraPix already defines for host
> API keys; copy it from the auth docs verbatim for production use.

## Metering events

When the SDK successfully handshakes with AuraPix, the backend emits:

- `embed.session_started` — already in the metering bus today, fired from
  the CSP middleware when an allowed parent origin frames the embed.
- `embed.session_ended` — fired by AuraPix when the SDK calls its
  beacon endpoint (`POST /v1/tenants/:tenantId/embed/session-end`),
  either from `handle.destroy()` or the page's `pagehide` event.

Hosts use these to bill on **active embed sessions** (proxy for MAU) and
**session minutes**.

## Building

```bash
cd packages/embed-sdk
npm run build
# → dist/index.mjs, dist/index.cjs, dist/index.d.ts
```

The build enforces a **2 KB gzipped** size budget on the ESM bundle (issue
#177 acceptance criterion) and will fail CI if exceeded.

## Testing

```bash
cd packages/embed-sdk
npx vitest run
```

Tests cover option validation, iframe construction, origin / source
rejection, handshake timeout, the imperative API, and the destroy /
session-end beacon path.
