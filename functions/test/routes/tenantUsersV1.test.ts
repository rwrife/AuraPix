import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import type { DataAdapter, QueryFilter } from '../../src/adapters/data/DataAdapter.js';
import { createTenantUsersRouter } from '../../src/routes/tenantUsersV1.js';
import { UserActiveDebouncer } from '../../src/services/tenant/tenantMembershipService.js';
import type { MeteringEvent } from '../../src/services/metering/MeteringBus.js';
import type { TenantApiKeyScope } from '../../src/models/TenantApiKey.js';

function createInMemoryAdapter(): DataAdapter & {
  store: Map<string, Map<string, any>>;
} {
  const store = new Map<string, Map<string, any>>();
  function col(name: string): Map<string, any> {
    let c = store.get(name);
    if (!c) {
      c = new Map();
      store.set(name, c);
    }
    return c;
  }
  return {
    store,
    async storeData(c, id, d) {
      col(c).set(id, { ...(d as object) });
    },
    async fetchData(c, id) {
      const v = col(c).get(id);
      return v ? { ...v } : null;
    },
    async queryData<T>(c: string, filters: QueryFilter[]): Promise<T[]> {
      const all = Array.from(col(c).values()).map((v) => ({ ...v }));
      return all.filter((doc) =>
        filters.every((f) => (doc as any)[f.field] === f.value)
      ) as T[];
    },
    async updateData(c, id, u) {
      const existing = col(c).get(id);
      if (existing) col(c).set(id, { ...existing, ...(u as object) });
    },
    async deleteData(c, id) {
      col(c).delete(id);
    },
    async exists(c, id) {
      return col(c).has(id);
    },
    async listIds(c) {
      return Array.from(col(c).keys());
    },
    async getPhoto() {
      return null;
    },
  };
}

function makeApp(opts: {
  adapter: DataAdapter;
  tenantCtx?: { id: string; scopes: TenantApiKeyScope[] };
  events?: MeteringEvent[];
  debouncer?: UserActiveDebouncer;
  userId?: string;
}): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.tenantCtx) {
      req.tenant = { ...opts.tenantCtx, keyId: 'k1' } as any;
    }
    if (opts.userId) (req as any).user = { uid: opts.userId };
    next();
  });
  app.use(
    '/api/v1/tenants',
    createTenantUsersRouter({
      dataAdapter: opts.adapter,
      meteringBus: opts.events
        ? { emit: (e) => opts.events!.push(e) }
        : undefined,
      userActiveDebouncer: opts.debouncer,
    })
  );
  return app;
}

interface Resp { status: number; body: any; }
function call(
  app: Express,
  method: string,
  path: string,
  body?: any
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const data = body ? JSON.stringify(body) : '';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: data
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            : {},
        },
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
            } catch {
              resolve({ status: res.statusCode ?? 0, body: raw });
            }
          });
        }
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (data) req.write(data);
      req.end();
    });
  });
}

const T = 'tenant-A';
const OTHER = 'tenant-B';
const writeCtx = { id: T, scopes: ['tenants:write', 'tenants.read'] as TenantApiKeyScope[] };
const readCtx = { id: T, scopes: ['tenants.read'] as TenantApiKeyScope[] };

describe('Tenant users API', () => {
  let adapter: ReturnType<typeof createInMemoryAdapter>;
  let events: MeteringEvent[];

  beforeEach(() => {
    adapter = createInMemoryAdapter();
    events = [];
  });

  describe('POST /v1/tenants/:tenantId/users', () => {
    it('creates a new membership and emits user.provisioned', async () => {
      const app = makeApp({ adapter, tenantCtx: writeCtx, events });
      const res = await call(app, 'POST', `/api/v1/tenants/${T}/users`, {
        email: 'a@example.com',
        userId: 'u1',
        role: 'editor',
      });
      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({
        userId: 'u1',
        tenantId: T,
        email: 'a@example.com',
        role: 'editor',
        lastActiveAt: null,
      });
      expect(events.some((e) => e.type === 'user.provisioned' && e.resourceId === 'u1')).toBe(true);
    });

    it('rejects invalid role', async () => {
      const app = makeApp({ adapter, tenantCtx: writeCtx, events });
      const res = await call(app, 'POST', `/api/v1/tenants/${T}/users`, {
        email: 'a@example.com',
        role: 'admin',
      });
      expect(res.status).toBe(400);
    });

    it('rejects missing email', async () => {
      const app = makeApp({ adapter, tenantCtx: writeCtx });
      const res = await call(app, 'POST', `/api/v1/tenants/${T}/users`, { role: 'viewer' });
      expect(res.status).toBe(400);
    });

    it('returns 401 without a host API key', async () => {
      const app = makeApp({ adapter });
      const res = await call(app, 'POST', `/api/v1/tenants/${T}/users`, {
        email: 'a@example.com', role: 'viewer',
      });
      expect(res.status).toBe(401);
    });

    it('returns 403 when scope is missing (tenants.read only)', async () => {
      const app = makeApp({ adapter, tenantCtx: readCtx });
      const res = await call(app, 'POST', `/api/v1/tenants/${T}/users`, {
        email: 'a@example.com', role: 'viewer',
      });
      expect(res.status).toBe(403);
    });

    it('cross-tenant write returns 404 (not 403) — never leak existence', async () => {
      // Caller is authenticated for OTHER but targets T.
      const app = makeApp({
        adapter,
        tenantCtx: { id: OTHER, scopes: ['tenants:write'] },
      });
      const res = await call(app, 'POST', `/api/v1/tenants/${T}/users`, {
        email: 'a@example.com', role: 'editor',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/tenants/:tenantId/users', () => {
    it('lists members (excludes revoked)', async () => {
      const writeApp = makeApp({ adapter, tenantCtx: writeCtx, events });
      await call(writeApp, 'POST', `/api/v1/tenants/${T}/users`, {
        email: 'a@example.com', userId: 'u1', role: 'owner',
      });
      await call(writeApp, 'POST', `/api/v1/tenants/${T}/users`, {
        email: 'b@example.com', userId: 'u2', role: 'viewer',
      });
      await call(writeApp, 'DELETE', `/api/v1/tenants/${T}/users/u2`);

      const readApp = makeApp({ adapter, tenantCtx: readCtx });
      const res = await call(readApp, 'GET', `/api/v1/tenants/${T}/users`);
      expect(res.status).toBe(200);
      expect(res.body.users).toHaveLength(1);
      expect(res.body.users[0].userId).toBe('u1');
    });

    it('cross-tenant list returns 404', async () => {
      const app = makeApp({
        adapter,
        tenantCtx: { id: OTHER, scopes: ['tenants.read'] },
      });
      const res = await call(app, 'GET', `/api/v1/tenants/${T}/users`);
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /v1/tenants/:tenantId/users/:userId', () => {
    it('updates role', async () => {
      const app = makeApp({ adapter, tenantCtx: writeCtx, events });
      await call(app, 'POST', `/api/v1/tenants/${T}/users`, {
        email: 'a@example.com', userId: 'u1', role: 'viewer',
      });
      const res = await call(app, 'PATCH', `/api/v1/tenants/${T}/users/u1`, { role: 'editor' });
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('editor');
    });

    it('viewer scope cannot patch (403)', async () => {
      const writeApp = makeApp({ adapter, tenantCtx: writeCtx });
      await call(writeApp, 'POST', `/api/v1/tenants/${T}/users`, {
        email: 'a@example.com', userId: 'u1', role: 'viewer',
      });
      const readApp = makeApp({ adapter, tenantCtx: readCtx });
      const res = await call(readApp, 'PATCH', `/api/v1/tenants/${T}/users/u1`, { role: 'editor' });
      expect(res.status).toBe(403);
    });

    it('missing membership returns 404', async () => {
      const app = makeApp({ adapter, tenantCtx: writeCtx });
      const res = await call(app, 'PATCH', `/api/v1/tenants/${T}/users/ghost`, { role: 'editor' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /v1/tenants/:tenantId/users/:userId', () => {
    it('revokes membership and emits user.revoked', async () => {
      const app = makeApp({ adapter, tenantCtx: writeCtx, events });
      await call(app, 'POST', `/api/v1/tenants/${T}/users`, {
        email: 'a@example.com', userId: 'u1', role: 'editor',
      });
      const res = await call(app, 'DELETE', `/api/v1/tenants/${T}/users/u1`);
      expect(res.status).toBe(204);
      expect(events.some((e) => e.type === 'user.revoked' && e.resourceId === 'u1')).toBe(true);

      // Second delete returns 404 — already revoked / invisible.
      const res2 = await call(app, 'DELETE', `/api/v1/tenants/${T}/users/u1`);
      expect(res2.status).toBe(404);
    });
  });

  describe('user.active activity middleware', () => {
    it('emits at most once per (tenant,user,day)', async () => {
      const debouncer = new UserActiveDebouncer();
      const app = makeApp({
        adapter,
        tenantCtx: readCtx,
        events,
        userId: 'u-active',
        debouncer,
      });
      // Two reads on the same day -> exactly one user.active emission.
      await call(app, 'GET', `/api/v1/tenants/${T}/users`);
      await call(app, 'GET', `/api/v1/tenants/${T}/users`);
      const activeCount = events.filter((e) => e.type === 'user.active').length;
      expect(activeCount).toBe(1);
    });

    it('does not emit when there is no userId', async () => {
      const app = makeApp({ adapter, tenantCtx: readCtx, events });
      await call(app, 'GET', `/api/v1/tenants/${T}/users`);
      expect(events.some((e) => e.type === 'user.active')).toBe(false);
    });
  });
});

describe('UserActiveDebouncer', () => {
  it('emits once per UTC day', () => {
    const d = new UserActiveDebouncer();
    expect(d.shouldEmit('t', 'u', '2026-05-25T01:00:00.000Z')).toBe(true);
    expect(d.shouldEmit('t', 'u', '2026-05-25T23:59:00.000Z')).toBe(false);
    expect(d.shouldEmit('t', 'u', '2026-05-26T00:00:00.000Z')).toBe(true);
  });
  it('partitions by tenant and user', () => {
    const d = new UserActiveDebouncer();
    d.shouldEmit('t1', 'u1', '2026-05-25T00:00:00Z');
    expect(d.shouldEmit('t2', 'u1', '2026-05-25T00:00:00Z')).toBe(true);
    expect(d.shouldEmit('t1', 'u2', '2026-05-25T00:00:00Z')).toBe(true);
  });
});
