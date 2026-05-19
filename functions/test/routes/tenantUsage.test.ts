import { describe, expect, it } from 'vitest';
import express from 'express';
import { createTenantUsageRouter } from '../../src/routes/tenantUsage.js';
import { InMemoryDailyDocStore, UsageRollupConsumer } from '../../src/services/metering/UsageRollupConsumer.js';

function makeApp(opts: {
  store: InMemoryDailyDocStore;
  ownerUserId?: string;
  tenantId?: string;
  authUserId?: string | null;
  hostScopeChecker?: Parameters<typeof createTenantUsageRouter>[0]['hostScopeChecker'];
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.authUserId !== null && opts.authUserId !== undefined) {
      req.user = { uid: opts.authUserId };
    }
    next();
  });
  app.use(
    '/api/v1/tenants',
    createTenantUsageRouter({
      store: opts.store,
      ownsTenant: async (userId, tenantId) =>
        userId === opts.ownerUserId && tenantId === opts.tenantId,
      hostScopeChecker: opts.hostScopeChecker,
    })
  );
  return app;
}

async function req(app: express.Express, path: string): Promise<{ status: number; body: any }> {
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
              resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
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

const tenantId = 'tenant-A';
const ownerUserId = 'user-1';

describe('GET /v1/tenants/:tenantId/usage', () => {
  it('returns a populated range for the owner', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);
    await consumer.apply({ tenantId, counter: 'apiCalls', value: 4, occurredAt: '2026-04-01T10:00:00Z' });
    await consumer.apply({ tenantId, counter: 'imagesUploaded', value: 2, occurredAt: '2026-04-02T10:00:00Z' });

    const app = makeApp({ store, ownerUserId, tenantId, authUserId: ownerUserId });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage?from=2026-04-01&to=2026-04-03');

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe('tenant-A');
    expect(res.body.days).toBe(3);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items[0]).toMatchObject({ date: '2026-04-01', apiCalls: 4 });
    expect(res.body.items[1]).toMatchObject({ date: '2026-04-02', imagesUploaded: 2 });
    expect(res.body.items[2]).toMatchObject({ date: '2026-04-03', apiCalls: 0 });
  });

  it('rejects cross-tenant access with 403', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId: 'tenant-OTHER', authUserId: ownerUserId });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage?from=2026-04-01&to=2026-04-02');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows host API key with usage.read scope', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({
      store,
      ownerUserId,
      tenantId,
      authUserId: null, // no Bearer user
      hostScopeChecker: async (_req, t, scope) => t === tenantId && scope === 'usage.read',
    });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage?from=2026-04-01&to=2026-04-02');
    expect(res.status).toBe(200);
  });

  it('rejects ranges exceeding 100 days', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId, authUserId: ownerUserId });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage?from=2026-01-01&to=2026-05-01');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RANGE_TOO_LARGE');
  });

  it('accepts exactly 100 days', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId, authUserId: ownerUserId });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage?from=2026-01-01&to=2026-04-10');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(100);
  });

  it('validates date format', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId, authUserId: ownerUserId });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage?from=2026-13-01&to=2026-04-02');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects from > to', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId, authUserId: ownerUserId });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage?from=2026-04-05&to=2026-04-01');
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated callers when no host scope is granted', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId, authUserId: null });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage?from=2026-04-01&to=2026-04-02');
    expect(res.status).toBe(403);
  });
});
