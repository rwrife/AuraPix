/**
 * Tests for the per-share-link analytics endpoint (issue #198).
 *
 * The route sits behind the tenant-scoped host-API-key middleware plus
 * a bearer-fallback ownership check. Both paths are exercised here.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { InMemoryShareViewStore } from '../../src/services/sharing/ShareViewStore.js';
import {
  createShareLinkAnalyticsRouter,
  buildLast7DaysSeries,
  type ShareLinkAnalyticsResponse,
} from '../../src/routes/shareLinkAnalyticsV1.js';

/**
 * Minimal HTTP helper. We deliberately don't pull in supertest \u2014 the
 * rest of the routes suite uses a hand-rolled `req()` so this test
 * matches that style.
 */
async function req(
  app: express.Express,
  path: string
): Promise<{ status: number; body: any }> {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const reqObj = http.request(
        { host: '127.0.0.1', port, path, method: 'GET' },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            server.close();
            try {
              resolve({
                status: res.statusCode ?? 0,
                body: raw ? JSON.parse(raw) : null,
              });
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      reqObj.on('error', (err) => {
        server.close();
        reject(err);
      });
      reqObj.end();
    });
  });
}

/**
 * Build a mounted Express app that exercises the real router but injects
 * a synthetic auth context so we can test each auth path in isolation.
 *
 * - `tenantCtx`: simulates the host-API-key middleware setting `req.tenant`.
 * - `authUserId`: simulates Bearer auth setting `req.user`.
 */
function makeApp(opts: {
  store: InMemoryShareViewStore;
  ownsTenant?: (userId: string, tenantId: string) => Promise<boolean>;
  tenantCtx?: { id: string; scopes: string[]; keyId?: string } | null;
  authUserId?: string | null;
  now?: () => Date;
}): express.Express {
  const app = express();
  app.use((r, _res, next: NextFunction) => {
    if (opts.tenantCtx) {
      (r as unknown as { tenant: unknown }).tenant = opts.tenantCtx;
    }
    if (opts.authUserId) {
      (r as unknown as { user: { uid: string } }).user = { uid: opts.authUserId };
    }
    next();
  });
  const router = createShareLinkAnalyticsRouter({
    store: opts.store,
    ownsTenant: opts.ownsTenant ?? (async (u, t) => u === t),
    now: opts.now,
  });
  app.use('/v1/tenants', router);
  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction
    ): void => {
      res.status(500).json({ error: { message: String(err) } });
    }
  );
  return app;
}

const tenantId = 'tenant-A';
const linkId = 'link-1';
const url = `/v1/tenants/${tenantId}/share-links/${linkId}/analytics`;

describe('GET /v1/tenants/:tenantId/share-links/:linkId/analytics', () => {
  it('returns zero-filled totals for a link with no views', async () => {
    const store = new InMemoryShareViewStore();
    const app = makeApp({
      store,
      tenantCtx: { id: tenantId, scopes: ['usage.read'] },
      now: () => new Date('2026-04-07T00:00:00.000Z'),
    });
    const res = await req(app, url);
    expect(res.status).toBe(200);
    const body = res.body as ShareLinkAnalyticsResponse;
    expect(body).toMatchObject({
      linkId,
      tenantId,
      totalViews: 0,
      uniqueViewers: 0,
      bytesServed: 0,
      lastViewedAt: null,
    });
    expect(body.last7DaysSeries).toHaveLength(7);
    expect(body.last7DaysSeries.every((p) => p.views === 0)).toBe(true);
    expect(body.last7DaysSeries[6]!.date).toBe('2026-04-07');
    expect(body.last7DaysSeries[0]!.date).toBe('2026-04-01');
  });

  it('returns aggregate totals + 7-day series for a link with views', async () => {
    const store = new InMemoryShareViewStore();
    await store.recordView({
      linkId,
      tenantId,
      viewedAt: '2026-04-05T12:00:00.000Z',
      ipHash: 'ip-A',
      uaHash: 'ua-1',
      referrerHost: 'client.example.com',
      bytesServed: 1000,
    });
    await store.recordView({
      linkId,
      tenantId,
      viewedAt: '2026-04-06T12:00:00.000Z',
      ipHash: 'ip-B',
      uaHash: 'ua-2',
      referrerHost: null,
      bytesServed: 500,
    });
    // Duplicate within the window \u2014 must NOT bump the totals.
    await store.recordView({
      linkId,
      tenantId,
      viewedAt: '2026-04-06T12:00:30.000Z',
      ipHash: 'ip-B',
      uaHash: 'ua-2',
      referrerHost: null,
      bytesServed: 500,
    });

    const app = makeApp({
      store,
      tenantCtx: { id: tenantId, scopes: ['usage.read'] },
      now: () => new Date('2026-04-07T00:00:00.000Z'),
    });
    const res = await req(app, url);
    expect(res.status).toBe(200);
    const body = res.body as ShareLinkAnalyticsResponse;
    expect(body.totalViews).toBe(2);
    expect(body.uniqueViewers).toBe(2);
    expect(body.bytesServed).toBe(1500);
    expect(body.lastViewedAt).toBe('2026-04-06T12:00:00.000Z');
    // Time series has entries for both view days.
    const day5 = body.last7DaysSeries.find((p) => p.date === '2026-04-05')!;
    const day6 = body.last7DaysSeries.find((p) => p.date === '2026-04-06')!;
    expect(day5.views).toBe(1);
    expect(day5.bytesServed).toBe(1000);
    expect(day6.views).toBe(1);
    expect(day6.bytesServed).toBe(500);
  });

  it('cross-tenant probes return the empty shape (never confirm foreign links)', async () => {
    const store = new InMemoryShareViewStore();
    // Link belongs to tenant-B \u2026
    await store.recordView({
      linkId,
      tenantId: 'tenant-B',
      viewedAt: '2026-04-05T12:00:00.000Z',
      ipHash: 'ip-A',
      uaHash: 'ua-1',
      referrerHost: null,
      bytesServed: 999,
    });
    // \u2026 but tenant-A asks for it.
    const app = makeApp({
      store,
      tenantCtx: { id: tenantId, scopes: ['usage.read'] },
      now: () => new Date('2026-04-07T00:00:00.000Z'),
    });
    const res = await req(app, url);
    expect(res.status).toBe(200);
    // Aggregate values do NOT leak from the foreign tenant.
    expect(res.body.totalViews).toBe(0);
    expect(res.body.bytesServed).toBe(0);
    expect(res.body.lastViewedAt).toBeNull();
  });

  it('rejects invalid linkId with 400', async () => {
    const store = new InMemoryShareViewStore();
    const app = makeApp({
      store,
      tenantCtx: { id: tenantId, scopes: ['usage.read'] },
    });
    const res = await req(
      app,
      `/v1/tenants/${tenantId}/share-links/${'!!!bad!!!'}/analytics`
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_LINK_ID');
  });

  it('accepts a bearer-authed tenant owner (no host key present)', async () => {
    const store = new InMemoryShareViewStore();
    const app = makeApp({
      store,
      tenantCtx: null,
      authUserId: tenantId,
      ownsTenant: async (u, t) => u === t,
    });
    const res = await req(app, url);
    expect(res.status).toBe(200);
  });

  it('rejects a bearer-authed user who does not own the tenant', async () => {
    const store = new InMemoryShareViewStore();
    const app = makeApp({
      store,
      tenantCtx: null,
      authUserId: 'stranger',
      ownsTenant: async (u, t) => u === t,
    });
    const res = await req(app, url);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects unauthenticated callers', async () => {
    // With no host key and no Bearer user, the middleware rejects with 401.
    const store = new InMemoryShareViewStore();
    const app = makeApp({ store, tenantCtx: null, authUserId: null });
    const res = await req(app, url);
    expect(res.status).toBe(401);
  });
});

describe('buildLast7DaysSeries', () => {
  it('returns 7 entries ending on `now` and pre-filled with zeros', () => {
    const series = buildLast7DaysSeries([], new Date('2026-06-10T05:00:00Z'));
    expect(series).toHaveLength(7);
    expect(series[0]!.date).toBe('2026-06-04');
    expect(series[6]!.date).toBe('2026-06-10');
    for (const p of series) {
      expect(p.views).toBe(0);
      expect(p.bytesServed).toBe(0);
    }
  });

  it('aggregates rows into the correct UTC day', () => {
    const rows = [
      {
        id: '1',
        linkId,
        tenantId,
        viewedAt: '2026-06-08T23:59:59Z',
        ipHash: 'a',
        uaHash: 'b',
        referrerHost: null,
        bytesServed: 100,
      },
      {
        id: '2',
        linkId,
        tenantId,
        viewedAt: '2026-06-09T00:00:01Z',
        ipHash: 'a',
        uaHash: 'b',
        referrerHost: null,
        bytesServed: 250,
      },
    ];
    const series = buildLast7DaysSeries(rows, new Date('2026-06-10T05:00:00Z'));
    const june8 = series.find((p) => p.date === '2026-06-08')!;
    const june9 = series.find((p) => p.date === '2026-06-09')!;
    expect(june8.views).toBe(1);
    expect(june8.bytesServed).toBe(100);
    expect(june9.views).toBe(1);
    expect(june9.bytesServed).toBe(250);
  });

  it('ignores rows outside the 7-day window', () => {
    const rows = [
      {
        id: '1',
        linkId,
        tenantId,
        viewedAt: '2026-05-01T12:00:00Z',
        ipHash: 'a',
        uaHash: 'b',
        referrerHost: null,
        bytesServed: 100,
      },
    ];
    const series = buildLast7DaysSeries(rows, new Date('2026-06-10T05:00:00Z'));
    for (const p of series) {
      expect(p.views).toBe(0);
      expect(p.bytesServed).toBe(0);
    }
  });
});
