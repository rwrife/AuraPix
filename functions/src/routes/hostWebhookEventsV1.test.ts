/**
 * Route-level tests for the public webhook event catalog endpoint
 * (issue #176). Uses real Express + node fetch so the full middleware
 * stack (host API key auth, ETag/304 handling) is exercised end-to-end.
 *
 * Covers:
 *   - Anonymous request is rejected with 401
 *   - User Bearer (no host key) is rejected with 401
 *   - Valid host API key returns 200 + the catalog
 *   - Response contains a `catalogVersion` and every currently-emitted
 *     event type in the codebase
 *   - ETag header is present and stable across requests
 *   - `If-None-Match` with the current ETag returns 304
 *   - `If-None-Match: *` returns 304
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalJsonData } from '../adapters/data/LocalJsonData.js';
import { createHostWebhookEventsRouter } from './hostWebhookEventsV1.js';
import { createHostApiKeyAuth } from '../middleware/hostApiKeyAuth.js';
import { createTenantApiKey } from '../services/host/tenantApiKeyService.js';
import {
  CATALOG_VERSION,
  EVENT_CATALOG,
} from '../services/metering/eventCatalog.js';

interface Harness {
  baseUrl: string;
  shutdown(): Promise<void>;
  dataAdapter: LocalJsonData;
}

async function setupHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'host-webhook-events-route-test-'));
  const dataAdapter = new LocalJsonData(dir);
  const app = express();
  app.use(express.json());
  app.use(createHostApiKeyAuth(dataAdapter));
  app.use('/v1/host', createHostWebhookEventsRouter());

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataAdapter,
    shutdown: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

describe('hostWebhookEventsV1 router (issue #176)', () => {
  let harness: Harness;
  let validKey: string;

  beforeEach(async () => {
    harness = await setupHarness();
    const key = await createTenantApiKey(harness.dataAdapter, {
      tenantId: 'tenant-A',
      scopes: ['usage.read'],
      label: 'catalog-test',
    });
    validKey = key.plaintextSecret;
  });

  afterEach(async () => {
    await harness.shutdown();
  });

  it('returns 401 when no authentication is supplied', async () => {
    const res = await fetch(`${harness.baseUrl}/v1/host/webhook-events`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('HOST_API_KEY_REQUIRED');
  });

  it('returns 401 for a non-key Bearer token (user tokens not accepted)', async () => {
    const res = await fetch(`${harness.baseUrl}/v1/host/webhook-events`, {
      headers: { authorization: 'Bearer not-a-host-key' },
    });
    // The host-key middleware ignores non-`ak_live_` Bearers (so user
    // auth can layer underneath); the route guard then rejects because
    // `req.tenant` is unset.
    expect(res.status).toBe(401);
  });

  it('returns 401 for an invalid host API key', async () => {
    const res = await fetch(`${harness.baseUrl}/v1/host/webhook-events`, {
      headers: { authorization: 'Bearer ak_live_definitely-not-real' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 + catalog for a valid host API key', async () => {
    const res = await fetch(`${harness.baseUrl}/v1/host/webhook-events`, {
      headers: { authorization: `Bearer ${validKey}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const body = (await res.json()) as {
      catalogVersion: string;
      events: Array<{
        name: string;
        version: number;
        billable: boolean;
        description: string;
        schema: Record<string, unknown>;
      }>;
    };
    expect(body.catalogVersion).toBe(CATALOG_VERSION);
    expect(body.events.length).toBe(EVENT_CATALOG.length);

    // Spot-check a billable event and a non-billable one.
    const photoExported = body.events.find((e) => e.name === 'photo.exported');
    expect(photoExported).toBeDefined();
    expect(photoExported!.billable).toBe(true);
    expect(photoExported!.schema.type).toBe('object');

    const featureGated = body.events.find((e) => e.name === 'feature.gated');
    expect(featureGated).toBeDefined();
    expect(featureGated!.billable).toBe(false);
  });

  it('serves a stable ETag and Cache-Control header', async () => {
    const first = await fetch(`${harness.baseUrl}/v1/host/webhook-events`, {
      headers: { authorization: `Bearer ${validKey}` },
    });
    const etag1 = first.headers.get('etag');
    expect(etag1).toBeTruthy();
    expect(etag1).toMatch(/^W\/"[\w.-]+-[0-9a-f]{16}"$/);
    expect(first.headers.get('cache-control')).toContain('public');

    const second = await fetch(`${harness.baseUrl}/v1/host/webhook-events`, {
      headers: { authorization: `Bearer ${validKey}` },
    });
    expect(second.headers.get('etag')).toBe(etag1);
  });

  it('returns 304 when If-None-Match matches the current ETag', async () => {
    const first = await fetch(`${harness.baseUrl}/v1/host/webhook-events`, {
      headers: { authorization: `Bearer ${validKey}` },
    });
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();

    const second = await fetch(`${harness.baseUrl}/v1/host/webhook-events`, {
      headers: {
        authorization: `Bearer ${validKey}`,
        'if-none-match': etag,
      },
    });
    expect(second.status).toBe(304);
    const text = await second.text();
    expect(text).toBe('');
  });

  it('returns 304 for If-None-Match: *', async () => {
    const res = await fetch(`${harness.baseUrl}/v1/host/webhook-events`, {
      headers: {
        authorization: `Bearer ${validKey}`,
        'if-none-match': '*',
      },
    });
    expect(res.status).toBe(304);
  });
});

/**
 * Registry guard: every event name used by `emitMeteringEvent({ type: ... })`
 * anywhere in `functions/src/` must exist in the registry. This is the
 * compile-time-plus-test belt-and-suspenders guarantee from the issue's
 * acceptance criteria.
 *
 * Scans the source tree for the pattern `type: '<domain>.<name>'` inside
 * `emitMeteringEvent`-adjacent code. Keeps the regex narrow enough that
 * unrelated string literals don't trigger false positives.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) {
      continue;
    }
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p, out);
    } else if (
      (p.endsWith('.ts') || p.endsWith('.tsx')) &&
      !p.endsWith('.test.ts') &&
      !p.endsWith('.spec.ts')
    ) {
      out.push(p);
    }
  }
  return out;
}

describe('event catalog registry guard', () => {
  it('every emitted event name in functions/src exists in EVENT_CATALOG', () => {
    const functionsSrc = pathResolve(__dirname, '..');
    const files = walk(functionsSrc);

    const registeredNames = new Set<string>(EVENT_CATALOG.map((e) => e.name));
    // Two well-known non-metering type strings appear in metering code and
    // are NOT bus events (they're internal bus / rollup notifications).
    const allowlist = new Set([
      // `storageSnapshot.ts` emits an internal `metering.rollup.completed`
      // signal on the usage bus, not the metering bus. Not part of the
      // public webhook catalog.
      'metering.rollup.completed',
    ]);

    const found = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // Skip the registry itself \u2014 it defines the canonical names.
      if (file.endsWith('eventCatalog.ts')) continue;
      // Skip the bus / sink themselves \u2014 they define the type only.
      if (file.endsWith('MeteringBus.ts')) continue;
      if (file.endsWith('HostWebhookSink.ts')) continue;

      // Only count `type: '...'` literals that look like dotted event
      // names (`<word>.<word>`). This is intentionally narrow so unrelated
      // type discriminators in tests / handlers don't false-positive.
      const re = /type:\s*'([a-z_]+\.[a-z_]+)'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const name = m[1]!;
        if (allowlist.has(name)) continue;
        found.add(name);
      }
    }

    const missing = [...found].filter((n) => !registeredNames.has(n)).sort();
    expect(missing, `Unregistered event names: ${missing.join(', ')}`).toEqual(
      []
    );
  });
});
