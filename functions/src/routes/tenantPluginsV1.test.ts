import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { TENANT_PLUGIN_CONFIG_COLLECTION } from '../models/TenantPluginConfig.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../services/metering/MeteringBus.js';
import { setMeteringBus } from '../services/metering/index.js';
import { createTenantPluginsRouter } from './tenantPluginsV1.js';

class CapturingSink implements MeteringSink {
  events: NormalizedMeteringEvent[] = [];
  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

interface FakeTenant {
  id: string;
  scopes: string[];
  keyId?: string;
}

/**
 * Build an express app pre-wired with the plugin router. The
 * `tenantInjector` middleware lets each test simulate the host-API-key
 * middleware's effect by populating `req.tenant`.
 */
function makeApp(
  data: DataAdapter,
  tenantInjector: (req: any) => void = () => {}
): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    tenantInjector(req);
    next();
  });
  app.use('/api/v1/tenants', createTenantPluginsRouter({ dataAdapter: data }));
  app.use(errorHandler);
  return app;
}

function makeMemoryAdapter(): {
  data: DataAdapter;
  store: Map<string, Map<string, unknown>>;
} {
  const store = new Map<string, Map<string, unknown>>();
  const get = (collection: string) => {
    let inner = store.get(collection);
    if (!inner) {
      inner = new Map();
      store.set(collection, inner);
    }
    return inner;
  };
  const data: DataAdapter = {
    storeData: vi.fn(async (collection: string, id: string, value: unknown) => {
      get(collection).set(id, value);
    }),
    fetchData: vi.fn(async <T>(collection: string, id: string) => {
      return (get(collection).get(id) ?? null) as T | null;
    }),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(async () => {}),
    deleteData: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => null),
  } as unknown as DataAdapter;
  return { data, store };
}

async function request(
  app: Express,
  method: 'get' | 'put',
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  // Minimal supertest-free request helper using node:http.
  const { createServer } = await import('node:http');
  const server = createServer(app as unknown as (req: any, res: any) => void);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: method.toUpperCase(),
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('createTenantPluginsRouter', () => {
  describe('GET /:tenantId/plugins', () => {
    it('returns 401 when no host API key is present', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data);
      const res = await request(app, 'get', '/api/v1/tenants/tenant-a/plugins');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('HOST_API_KEY_REQUIRED');
    });

    it('returns 403 on a cross-tenant request', async () => {
      const { data } = makeMemoryAdapter();
      const tenant: FakeTenant = {
        id: 'tenant-other',
        scopes: ['plugins.read'],
        keyId: 'tak_x',
      };
      const app = makeApp(data, (req) => {
        req.tenant = tenant;
      });
      const res = await request(app, 'get', '/api/v1/tenants/tenant-a/plugins');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CROSS_TENANT_FORBIDDEN');
    });

    it('returns 403 when scope is missing', async () => {
      const { data } = makeMemoryAdapter();
      const tenant: FakeTenant = {
        id: 'tenant-a',
        scopes: [], // no plugins.read
        keyId: 'tak_x',
      };
      const app = makeApp(data, (req) => {
        req.tenant = tenant;
      });
      const res = await request(app, 'get', '/api/v1/tenants/tenant-a/plugins');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
    });

    it('returns the manifest with all plugins enabled by default and persists a doc', async () => {
      const { data, store } = makeMemoryAdapter();
      const tenant: FakeTenant = {
        id: 'tenant-a',
        scopes: ['plugins.read'],
        keyId: 'tak_x',
      };
      const app = makeApp(data, (req) => {
        req.tenant = tenant;
      });
      const res = await request(app, 'get', '/api/v1/tenants/tenant-a/plugins');
      expect(res.status).toBe(200);
      expect(res.body.tenantId).toBe('tenant-a');
      expect(Array.isArray(res.body.plugins)).toBe(true);
      expect(res.body.plugins.every((p: any) => p.enabled === true)).toBe(true);
      expect(res.body.plugins.every((p: any) => p.builtIn === true)).toBe(true);
      // Backfill: a doc was persisted on first read.
      expect(
        store.get(TENANT_PLUGIN_CONFIG_COLLECTION)?.has('tenant-a')
      ).toBe(true);
    });
  });

  describe('PUT /:tenantId/plugins/:pluginId', () => {
    let sink: CapturingSink;
    let bus: MeteringBus;

    beforeEach(() => {
      sink = new CapturingSink();
      bus = new MeteringBus({ sink, flushIntervalMs: 10, maxBatchSize: 1 });
      setMeteringBus(bus);
    });
    afterEach(() => {
      setMeteringBus(null);
      vi.restoreAllMocks();
    });

    it('rejects unknown plugin ids with 404', async () => {
      const { data } = makeMemoryAdapter();
      const tenant: FakeTenant = {
        id: 'tenant-a',
        scopes: ['plugins.write'],
        keyId: 'tak_x',
      };
      const app = makeApp(data, (req) => {
        req.tenant = tenant;
      });
      const res = await request(
        app,
        'put',
        '/api/v1/tenants/tenant-a/plugins/bogus',
        { enabled: false }
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PLUGIN_NOT_FOUND');
    });

    it('rejects a missing `enabled` body field with 400', async () => {
      const { data } = makeMemoryAdapter();
      const tenant: FakeTenant = {
        id: 'tenant-a',
        scopes: ['plugins.write'],
        keyId: 'tak_x',
      };
      const app = makeApp(data, (req) => {
        req.tenant = tenant;
      });
      const res = await request(
        app,
        'put',
        '/api/v1/tenants/tenant-a/plugins/rotate',
        {}
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('disables a plugin and emits a plugin.disabled event', async () => {
      const { data } = makeMemoryAdapter();
      const tenant: FakeTenant = {
        id: 'tenant-a',
        scopes: ['plugins.write'],
        keyId: 'tak_x',
      };
      const app = makeApp(data, (req) => {
        req.tenant = tenant;
      });
      const res = await request(
        app,
        'put',
        '/api/v1/tenants/tenant-a/plugins/rotate',
        { enabled: false }
      );
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(true);
      expect(res.body.enabled).toBe(false);
      await bus.flush();
      const event = sink.events.find((e) => e.type === 'plugin.disabled');
      expect(event).toBeDefined();
      expect(event!.resourceId).toBe('rotate');
      expect((event!.meta as any).pluginId).toBe('rotate');
      expect((event!.meta as any).actor).toBe('tak_x');
    });

    it('does NOT emit an event when the new state matches the existing state', async () => {
      const { data } = makeMemoryAdapter();
      const tenant: FakeTenant = {
        id: 'tenant-a',
        scopes: ['plugins.write'],
        keyId: 'tak_x',
      };
      const app = makeApp(data, (req) => {
        req.tenant = tenant;
      });
      // First call sets it; second call is a no-op transition.
      await request(app, 'put', '/api/v1/tenants/tenant-a/plugins/rotate', {
        enabled: false,
      });
      sink.events = [];
      const res = await request(
        app,
        'put',
        '/api/v1/tenants/tenant-a/plugins/rotate',
        { enabled: false }
      );
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(false);
      await bus.flush();
      expect(
        sink.events.filter(
          (e) => e.type === 'plugin.disabled' || e.type === 'plugin.enabled'
        )
      ).toHaveLength(0);
    });

    it('re-enabling an already-disabled plugin emits plugin.enabled', async () => {
      const { data } = makeMemoryAdapter();
      const tenant: FakeTenant = {
        id: 'tenant-a',
        scopes: ['plugins.write'],
        keyId: 'tak_x',
      };
      const app = makeApp(data, (req) => {
        req.tenant = tenant;
      });
      await request(app, 'put', '/api/v1/tenants/tenant-a/plugins/rotate', {
        enabled: false,
      });
      sink.events = [];
      const res = await request(
        app,
        'put',
        '/api/v1/tenants/tenant-a/plugins/rotate',
        { enabled: true }
      );
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(true);
      await bus.flush();
      const event = sink.events.find((e) => e.type === 'plugin.enabled');
      expect(event).toBeDefined();
      expect(event!.resourceId).toBe('rotate');
    });
  });
});
