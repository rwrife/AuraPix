# `examples/embed-host`

Minimal HTML page demonstrating end-to-end use of the
[`@aurapix/embed`](../../packages/embed-sdk) SDK against a local dev
AuraPix backend.

## Run

From the repo root:

```bash
# 1. Start AuraPix dev backend + frontend (see top-level README).
npm run dev

# 2. In another terminal, serve this example directory.
npx serve examples/embed-host
# → http://localhost:3000
```

Open the served URL and click **Mount**. The page mounts an AuraPix iframe
into the page, drives `openPhoto` / `openAlbum` / `setTheme`, and logs the
forwarded `aurapix:event` payloads.

For production hosts:

- Replace `aurapixOrigin: 'http://localhost:5173'` with your AuraPix URL.
- Mint `userJwt` server-side using the host API key — never ship the API
  key to the browser. See `packages/embed-sdk/README.md` for a snippet.
