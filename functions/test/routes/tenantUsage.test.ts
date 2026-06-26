import { describe, expect, it } from 'vitest';
import express from 'express';
import { createTenantUsageRouter, CSV_COLUMNS } from '../../src/routes/tenantUsage.js';
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
