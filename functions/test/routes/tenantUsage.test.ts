import { describe, expect, it } from 'vitest';
import express from 'express';
import { createTenantUsageRouter, CSV_COLUMNS } from '../../src/routes/tenantUsage.js';
import { InMemoryDailyDocStore, UsageRollupConsumer } from '../../src/services/metering/UsageRollupConsumer.js';
import { InMemoryUserActiveDailyStore } from '../../src/services/metering/UserActiveDailyStore.js';

function makeApp(opts: {
  store: InMemoryDailyDocStore;
  ownerUserId?: string;
  tenantId?: string;
  authUserId?: string | null;
  hostScopeChecker?: Parameters<typeof createTenantUsageRouter>[0]['hostScopeChecker'];
  distinctActiveUsers?: Parameters<typeof createTenantUsageRouter>[0]['distinctActiveUsers'];
  now?: () => Date;
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
      distinctActiveUsers: opts.distinctActiveUsers,
      now: opts.now,
    })
  );
  return app;
}

interface RawResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

async function rawReq(
  app: express.Express,
  path: string,
  headers: Record<string, string> = {}
): Promise<RawResponse> {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const reqObj = http.request(
        { host: '127.0.0.1', port, path, method: 'GET', headers },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            server.close();
            resolve({
              status: res.statusCode ?? 0,
              body: raw,
              headers: res.headers as Record<string, string | string[] | undefined>,
            });
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

describe('GET /v1/tenants/:tenantId/usage — CSV (issue #186)', () => {
  it('locks the documented column order', () => {
    // This test is the contract. If you need to add a counter, append it
    // to the END of CSV_COLUMNS and update docs/features/usage-and-billing.md
    // + the OpenAPI response example in the SAME commit.
    expect(CSV_COLUMNS).toEqual([
      'tenantId',
      'date',
      'storageBytesDelta',
      'imagesUploaded',
      'imagesProcessed',
      'signedUrlsIssued',
      'editsApplied',
      'tagsApplied',
      'apiCalls',
      'exportBytes',
      'activeUsers',
      'rateLimited',
      'storageBytesTotal',
      'updatedAt',
    ]);
  });

  it('returns CSV when Accept: text/csv is sent', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId, authUserId: ownerUserId });
    const res = await rawReq(
      app,
      '/api/v1/tenants/tenant-A/usage?from=2026-04-01&to=2026-04-02',
      { Accept: 'text/csv' }
    );
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/^text\/csv/);
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    // Zero-filled rows for both days.
    expect(lines.length).toBe(3);
  });

  it('returns CSV when ?format=csv is set (fallback for tools that can\'t set Accept)', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId, authUserId: ownerUserId });
    const res = await rawReq(
      app,
      '/api/v1/tenants/tenant-A/usage?from=2026-04-01&to=2026-04-02&format=csv'
    );
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/^text\/csv/);
    expect(res.body.split('\n')[0]).toBe(CSV_COLUMNS.join(','));
  });

  it('falls back to JSON when Accept is */* (default for most HTTP clients)', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId, authUserId: ownerUserId });
    const res = await rawReq(
      app,
      '/api/v1/tenants/tenant-A/usage?from=2026-04-01&to=2026-04-02',
      { Accept: '*/*' }
    );
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/application\/json/);
  });

  it('matches a fixed byte-exact CSV fixture', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);
    // Deterministic counters across two days; the third day is zero-filled.
    await consumer.apply({
      tenantId,
      counter: 'apiCalls',
      value: 4,
      occurredAt: '2026-04-01T10:00:00Z',
      eventId: 'evt-1',
    });
    await consumer.apply({
      tenantId,
      counter: 'imagesUploaded',
      value: 2,
      occurredAt: '2026-04-02T10:00:00Z',
      eventId: 'evt-2',
    });
    await consumer.apply({
      tenantId,
      counter: 'storageBytesDelta',
      value: 1024,
      occurredAt: '2026-04-02T10:00:00Z',
      eventId: 'evt-3',
    });

    // Pin the auto-managed `updatedAt` so we can byte-compare. We do this by
    // round-tripping each present doc through the store with a fixed value.
    const fixedUpdatedAt = '2026-04-02T10:00:00.000Z';
    for (const day of ['2026-04-01', '2026-04-02']) {
      await store.transact(tenantId, day, (current) => ({
        ...current!,
        updatedAt: fixedUpdatedAt,
      }));
    }

    const app = makeApp({ store, ownerUserId, tenantId, authUserId: ownerUserId });
    const res = await rawReq(
      app,
      '/api/v1/tenants/tenant-A/usage?from=2026-04-01&to=2026-04-03&format=csv'
    );
    expect(res.status).toBe(200);
    // Zero-filled day (`2026-04-03`) uses `emptyDailyDoc`'s sentinel
    // updatedAt (`new Date(0).toISOString()`), which is part of the
    // documented contract.
    const expected = [
      CSV_COLUMNS.join(','),
      `tenant-A,2026-04-01,0,0,0,0,0,0,4,0,0,0,,${fixedUpdatedAt}`,
      `tenant-A,2026-04-02,1024,2,0,0,0,0,0,0,0,0,,${fixedUpdatedAt}`,
      'tenant-A,2026-04-03,0,0,0,0,0,0,0,0,0,0,,1970-01-01T00:00:00.000Z',
      '',
    ].join('\n');
    expect(res.body).toBe(expected);
  });

  it('zero-fills empty days as CSV rows (no gap handling required)', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId, authUserId: ownerUserId });
    const res = await rawReq(
      app,
      '/api/v1/tenants/tenant-A/usage?from=2026-04-01&to=2026-04-05',
      { Accept: 'text/csv' }
    );
    expect(res.status).toBe(200);
    const lines = res.body.trim().split('\n');
    expect(lines.length).toBe(6); // header + 5 days
    // Every data row starts with the tenantId column.
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]!.startsWith('tenant-A,')).toBe(true);
    }
  });

  it('streams the response without a Content-Length (i.e. chunked / non-buffered)', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId, authUserId: ownerUserId });
    const res = await rawReq(
      app,
      '/api/v1/tenants/tenant-A/usage?from=2026-01-01&to=2026-04-10',
      { Accept: 'text/csv' }
    );
    expect(res.status).toBe(200);
    // Either chunked transfer or no Content-Length at all means Node/Express
    // did not buffer the full body before sending headers — both satisfy the
    // "non-buffering" acceptance criterion. The opposite (a known
    // Content-Length) would indicate the body was fully materialised first.
    expect(res.headers['content-length']).toBeUndefined();
    const te = String(res.headers['transfer-encoding'] ?? '').toLowerCase();
    expect(te).toContain('chunked');
  });

  it('still returns 403 for cross-tenant CSV requests', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId: 'tenant-OTHER', authUserId: ownerUserId });
    const res = await rawReq(
      app,
      '/api/v1/tenants/tenant-A/usage?from=2026-04-01&to=2026-04-02&format=csv'
    );
    expect(res.status).toBe(403);
    // Error envelope is JSON — the CSV negotiation only applies on the happy path.
    expect(String(res.headers['content-type'])).toMatch(/application\/json/);
  });

  it('still rejects ranges > 100 days for CSV requests', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({ store, ownerUserId, tenantId, authUserId: ownerUserId });
    const res = await rawReq(
      app,
      '/api/v1/tenants/tenant-A/usage?from=2026-01-01&to=2026-05-01&format=csv',
      { Accept: 'text/csv' }
    );
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('RANGE_TOO_LARGE');
  });

  it('escapes CSV cells containing commas, quotes, or newlines per RFC 4180', async () => {
    // The renderer is the contract. We exercise it directly so we don't have
    // to smuggle CR/LF through an HTTP path. The end-to-end CSV path is
    // already covered by the byte-exact fixture test above.
    const { renderCsvCell, renderCsvRow } = (
      await import('../../src/routes/tenantUsage.js')
    ).__test;
    expect(renderCsvCell('plain')).toBe('plain');
    expect(renderCsvCell(42)).toBe('42');
    expect(renderCsvCell(null)).toBe('');
    expect(renderCsvCell(undefined)).toBe('');
    expect(renderCsvCell('has,comma')).toBe('"has,comma"');
    expect(renderCsvCell('has"quote')).toBe('"has""quote"');
    expect(renderCsvCell('has\nnewline')).toBe('"has\nnewline"');
    expect(renderCsvCell('has\r\ncrlf')).toBe('"has\r\ncrlf"');

    // End-to-end: a row whose tenantId triggers quoting renders correctly.
    const row = renderCsvRow({
      tenantId: 'tenant,with"quotes\nand-commas',
      date: '2026-04-01',
      storageBytesDelta: 0,
      imagesUploaded: 0,
      imagesProcessed: 0,
      signedUrlsIssued: 0,
      editsApplied: 0,
      tagsApplied: 0,
      apiCalls: 1,
      exportBytes: 0,
      activeUsers: 0,
      rateLimited: 0,
      storageBytesTotal: null,
      appliedEventIds: [],
      updatedAt: '2026-04-01T00:00:00.000Z',
    });
    expect(row).toBe(
      '"tenant,with""quotes\nand-commas",2026-04-01,0,0,0,0,0,0,1,0,0,0,,2026-04-01T00:00:00.000Z'
    );
  });
});

describe('GET /v1/tenants/:tenantId/usage/current (issue #188)', () => {
  // Pin "now" to 2026-04-15T12:34:56Z so periodStart=2026-04-01 and periodEnd=2026-04-15.
  const fixedNow = () => new Date('2026-04-15T12:34:56.000Z');

  it('returns zero-filled totals for a tenant with no activity', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({
      store,
      ownerUserId,
      tenantId,
      authUserId: ownerUserId,
      now: fixedNow,
    });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantId: 'tenant-A',
      periodStart: '2026-04-01',
      periodEnd: '2026-04-15',
      storageBytesDelta: 0,
      imagesUploaded: 0,
      imagesProcessed: 0,
      signedUrlsIssued: 0,
      editsApplied: 0,
      tagsApplied: 0,
      apiCalls: 0,
      exportBytes: 0,
      activeUsers: 0,
      rateLimited: 0,
    });
    expect(typeof res.body.generatedAt).toBe('string');
  });

  it('sums summable counters across a partial month', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);
    // Three days in the current month with activity.
    await consumer.apply({ tenantId, counter: 'apiCalls', value: 5, occurredAt: '2026-04-02T10:00:00Z' });
    await consumer.apply({ tenantId, counter: 'apiCalls', value: 7, occurredAt: '2026-04-05T10:00:00Z' });
    await consumer.apply({ tenantId, counter: 'imagesUploaded', value: 3, occurredAt: '2026-04-05T10:00:00Z' });
    await consumer.apply({ tenantId, counter: 'exportBytes', value: 1024, occurredAt: '2026-04-10T10:00:00Z' });
    // Activity from the previous month should NOT be included.
    await consumer.apply({ tenantId, counter: 'apiCalls', value: 99, occurredAt: '2026-03-15T10:00:00Z' });
    // Activity for a different tenant must not bleed in either.
    await consumer.apply({ tenantId: 'tenant-OTHER', counter: 'apiCalls', value: 50, occurredAt: '2026-04-05T10:00:00Z' });

    const app = makeApp({
      store,
      ownerUserId,
      tenantId,
      authUserId: ownerUserId,
      now: fixedNow,
    });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantId: 'tenant-A',
      periodStart: '2026-04-01',
      periodEnd: '2026-04-15',
      apiCalls: 12, // 5 + 7
      imagesUploaded: 3,
      exportBytes: 1024,
    });
  });

  it('returns the full month when "now" is the last day', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);
    // Spread one apiCall across each of 30 days of April 2026.
    for (let day = 1; day <= 30; day++) {
      const date = `2026-04-${String(day).padStart(2, '0')}T10:00:00Z`;
      await consumer.apply({ tenantId, counter: 'apiCalls', value: 1, occurredAt: date });
    }
    const app = makeApp({
      store,
      ownerUserId,
      tenantId,
      authUserId: ownerUserId,
      now: () => new Date('2026-04-30T23:59:59.000Z'),
    });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(res.status).toBe(200);
    expect(res.body.periodStart).toBe('2026-04-01');
    expect(res.body.periodEnd).toBe('2026-04-30');
    expect(res.body.apiCalls).toBe(30);
  });

  it('de-duplicates activeUsers across days when a DistinctActiveUsersQuery is wired', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);
    // Per-day activeUsers counter — naive sum would be 5.
    await consumer.apply({ tenantId, counter: 'activeUsers', value: 2, occurredAt: '2026-04-02T10:00:00Z' });
    await consumer.apply({ tenantId, counter: 'activeUsers', value: 2, occurredAt: '2026-04-03T10:00:00Z' });
    await consumer.apply({ tenantId, counter: 'activeUsers', value: 1, occurredAt: '2026-04-04T10:00:00Z' });
    // But the actual distinct set across the period is {alice, bob, carol}.
    const userActive = new InMemoryUserActiveDailyStore();
    await userActive.markIfFirst(tenantId, 'alice', '2026-04-02');
    await userActive.markIfFirst(tenantId, 'bob', '2026-04-02');
    await userActive.markIfFirst(tenantId, 'alice', '2026-04-03'); // duplicate user
    await userActive.markIfFirst(tenantId, 'carol', '2026-04-03');
    await userActive.markIfFirst(tenantId, 'bob', '2026-04-04'); // duplicate user
    // A user from a previous month is out of range.
    await userActive.markIfFirst(tenantId, 'dave', '2026-03-31');
    // A user from a different tenant must not leak in.
    await userActive.markIfFirst('tenant-OTHER', 'eve', '2026-04-05');

    const app = makeApp({
      store,
      ownerUserId,
      tenantId,
      authUserId: ownerUserId,
      now: fixedNow,
      distinctActiveUsers: userActive,
    });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(res.status).toBe(200);
    expect(res.body.activeUsers).toBe(3); // alice, bob, carol — NOT 5
  });

  it('falls back to summing per-day activeUsers when no DistinctActiveUsersQuery is wired', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);
    await consumer.apply({ tenantId, counter: 'activeUsers', value: 2, occurredAt: '2026-04-02T10:00:00Z' });
    await consumer.apply({ tenantId, counter: 'activeUsers', value: 3, occurredAt: '2026-04-03T10:00:00Z' });
    const app = makeApp({
      store,
      ownerUserId,
      tenantId,
      authUserId: ownerUserId,
      now: fixedNow,
    });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(res.status).toBe(200);
    expect(res.body.activeUsers).toBe(5); // sum, the conservative upper bound
  });

  it('rejects cross-tenant access with 403', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({
      store,
      ownerUserId,
      tenantId: 'tenant-OTHER',
      authUserId: ownerUserId,
      now: fixedNow,
    });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects unauthenticated callers when no host scope is granted (403)', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({
      store,
      ownerUserId,
      tenantId,
      authUserId: null,
      now: fixedNow,
    });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(res.status).toBe(403);
  });

  it('rejects host API key whose scope check fails (403)', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({
      store,
      ownerUserId,
      tenantId,
      authUserId: null,
      hostScopeChecker: async () => false, // explicit deny — missing scope
      now: fixedNow,
    });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows host API key with usage.read scope', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);
    await consumer.apply({ tenantId, counter: 'apiCalls', value: 4, occurredAt: '2026-04-05T10:00:00Z' });
    const app = makeApp({
      store,
      ownerUserId,
      tenantId,
      authUserId: null,
      hostScopeChecker: async (_req, t, scope) => t === tenantId && scope === 'usage.read',
      now: fixedNow,
    });
    const res = await req(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(res.status).toBe(200);
    expect(res.body.apiCalls).toBe(4);
  });

  it('sets Cache-Control: max-age=60 on responses', async () => {
    const store = new InMemoryDailyDocStore();
    const app = makeApp({
      store,
      ownerUserId,
      tenantId,
      authUserId: ownerUserId,
      now: fixedNow,
    });
    const res = await rawReq(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(res.status).toBe(200);
    expect(String(res.headers['cache-control'])).toMatch(/max-age=60/);
  });

  it('caches identical requests for 60s (second call is a HIT, no store re-read)', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);
    await consumer.apply({ tenantId, counter: 'apiCalls', value: 4, occurredAt: '2026-04-05T10:00:00Z' });
    const app = makeApp({
      store,
      ownerUserId,
      tenantId,
      authUserId: ownerUserId,
      now: fixedNow,
    });
    const first = await rawReq(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(first.status).toBe(200);
    expect(String(first.headers['x-cache'] ?? '')).toBe('MISS');

    // Mutate the store AFTER the first call. With a 60s in-memory cache and
    // no explicit cache-bust, the second call must see the cached payload.
    await consumer.apply({ tenantId, counter: 'apiCalls', value: 100, occurredAt: '2026-04-05T10:00:00Z' });

    const second = await rawReq(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(second.status).toBe(200);
    expect(String(second.headers['x-cache'] ?? '')).toBe('HIT');
    const body = JSON.parse(second.body);
    expect(body.apiCalls).toBe(4); // stale, as documented
  });

  it('exposes invalidateTenantCurrentCache so writers can bust the cache', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);
    await consumer.apply({ tenantId, counter: 'apiCalls', value: 4, occurredAt: '2026-04-05T10:00:00Z' });
    // Build the router directly so we can grab the invalidator handle.
    const router = createTenantUsageRouter({
      store,
      ownsTenant: async (uid, tid) => uid === ownerUserId && tid === tenantId,
      now: fixedNow,
    }) as ReturnType<typeof createTenantUsageRouter> & {
      invalidateTenantCurrentCache?: (tenantId: string) => void;
    };
    expect(typeof router.invalidateTenantCurrentCache).toBe('function');

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { uid: ownerUserId };
      next();
    });
    app.use('/api/v1/tenants', router);

    const first = await rawReq(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(JSON.parse(first.body).apiCalls).toBe(4);
    // Write more, then explicitly bust the cache.
    await consumer.apply({ tenantId, counter: 'apiCalls', value: 6, occurredAt: '2026-04-05T10:00:00Z' });
    router.invalidateTenantCurrentCache!(tenantId);

    const second = await rawReq(app, '/api/v1/tenants/tenant-A/usage/current');
    expect(String(second.headers['x-cache'] ?? '')).toBe('MISS');
    expect(JSON.parse(second.body).apiCalls).toBe(10);
  });

  it('caches per-tenant — invalidating one tenant does not affect another', async () => {
    const store = new InMemoryDailyDocStore();
    const router = createTenantUsageRouter({
      store,
      ownsTenant: async () => true, // simplify — any user owns any tenant
      now: fixedNow,
    }) as ReturnType<typeof createTenantUsageRouter> & {
      invalidateTenantCurrentCache?: (tenantId: string) => void;
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { uid: 'u' };
      next();
    });
    app.use('/api/v1/tenants', router);

    await rawReq(app, '/api/v1/tenants/tenant-A/usage/current');
    await rawReq(app, '/api/v1/tenants/tenant-B/usage/current');

    router.invalidateTenantCurrentCache!('tenant-A');

    const aRes = await rawReq(app, '/api/v1/tenants/tenant-A/usage/current');
    const bRes = await rawReq(app, '/api/v1/tenants/tenant-B/usage/current');
    expect(String(aRes.headers['x-cache'])).toBe('MISS'); // busted
    expect(String(bRes.headers['x-cache'])).toBe('HIT'); // still cached
  });

  it('helper functions: currentUtcMonthRange and sumCounters', async () => {
    const { currentUtcMonthRange, sumCounters } = (
      await import('../../src/routes/tenantUsage.js')
    ).__test;
    // currentUtcMonthRange: leading zero on single-digit month & day.
    expect(currentUtcMonthRange(new Date('2026-01-05T00:00:00Z'))).toEqual({
      periodStart: '2026-01-01',
      periodEnd: '2026-01-05',
    });
    expect(currentUtcMonthRange(new Date('2026-12-31T23:59:59Z'))).toEqual({
      periodStart: '2026-12-01',
      periodEnd: '2026-12-31',
    });
    // sumCounters: empty input yields zero-filled totals.
    expect(sumCounters([])).toMatchObject({
      apiCalls: 0,
      imagesUploaded: 0,
      activeUsers: 0,
      rateLimited: 0,
    });
  });
});

describe('InMemoryUserActiveDailyStore.listDistinctUsers (issue #188)', () => {
  it('returns distinct user IDs across an inclusive UTC date range, scoped to the tenant', async () => {
    const s = new InMemoryUserActiveDailyStore();
    await s.markIfFirst('tenant-A', 'alice', '2026-04-02');
    await s.markIfFirst('tenant-A', 'bob', '2026-04-02');
    await s.markIfFirst('tenant-A', 'alice', '2026-04-03'); // same user, later day
    await s.markIfFirst('tenant-A', 'carol', '2026-04-15');
    // Out of range and other tenant — must be excluded.
    await s.markIfFirst('tenant-A', 'dave', '2026-03-31');
    await s.markIfFirst('tenant-A', 'eve', '2026-05-01');
    await s.markIfFirst('tenant-OTHER', 'mallory', '2026-04-10');

    const result = await s.listDistinctUsers('tenant-A', '2026-04-01', '2026-04-15');
    expect(result.sort()).toEqual(['alice', 'bob', 'carol']);
  });

  it('preserves userIds containing the "::" separator (split-from-the-right)', async () => {
    const s = new InMemoryUserActiveDailyStore();
    await s.markIfFirst('tenant-A', 'foo::bar', '2026-04-02');
    const result = await s.listDistinctUsers('tenant-A', '2026-04-01', '2026-04-30');
    expect(result).toEqual(['foo::bar']);
  });

  it('returns an empty array for tenants with no recorded activity', async () => {
    const s = new InMemoryUserActiveDailyStore();
    const result = await s.listDistinctUsers('tenant-A', '2026-04-01', '2026-04-30');
    expect(result).toEqual([]);
  });
});
