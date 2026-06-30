/**
 * Unit tests for the per-tenant storage thresholds router (issue #196).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { createTenantStorageThresholdsRouter } from './tenantStorageThresholdsV1.js';
import {
  DEFAULT_STORAGE_THRESHOLDS,
  TENANTS_COLLECTION,
  type TenantRecord,
} from '../models/TenantRecord.js';

interface FakeTenant {
  id: string;
  scopes: string[];
  keyId?: string;
}

function makeApp(
  data: DataAdapter,
  inject: (req: express.Request) => void = () => {}
): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    inject(req);
    next();
  });
  const router = createTenantStorageThresholdsRouter({ dataAdapter: data });
  app.use('/v1/tenants', router);
  app.use(errorHandler);
  return app;
}

function makeMemoryAdapter(seed: Record<string, unknown> = {}): {
  data: DataAdapter;
  store: Map<string, Map<string, unknown>>;
} {
  const store = new Map<string, Map<string, unknown>>();
  for (const [key, value] of Object.entries(seed)) {
    const [collection, id] = key.split('::');
    if (!collection || !id) continue;
    if (!store.has(collection)) store.set(collection, new Map());
    store.get(collection)!.set(id, value);
  }
  const get = (collection: string) => {
    let inner = store.get(collection);
    if (!inner) {
      inner = new Map();
      store.set(collection, inner);
    }
    return inner;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = {
    storeData: vi.fn(async (collection: string, id: string, value: unknown) => {
      get(collection).set(id, value);
    }),
    fetchData: vi.fn(async (collection: string, id: string) => {
      return get(collection).get(id) ?? null;
    }),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(async () => {}),
    deleteData: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => null),
  };
  return { data: data as DataAdapter, store };
}

async function request(
  app: Express,
  method: 'get' | 'put' | 'delete' | 'post',
  path: string,
  body?: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  const { createServer } = await import('node:http');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

describe('createTenantStorageThresholdsRouter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /:tenantId/storage/thresholds', () => {
    it('401 when no auth context is present', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data);
      const { status } = await request(
        app,
        'get',
        '/v1/tenants/tenant-a/storage/thresholds'
      );
      expect(status).toBe(401);
    });

    it('403 when host API key targets a different tenant', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-other',
          scopes: ['tenants.read'],
        } satisfies FakeTenant;
      });
      const { status } = await request(
        app,
        'get',
        '/v1/tenants/tenant-a/storage/thresholds'
      );
      expect(status).toBe(403);
    });

    it('returns defaults when no override is set', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['tenants.read', 'tenants.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'get',
        '/v1/tenants/tenant-a/storage/thresholds'
      );
      expect(status).toBe(200);
      expect(body.tenantId).toBe('tenant-a');
      expect(body.thresholds).toEqual([...DEFAULT_STORAGE_THRESHOLDS]);
      expect(body.source).toBe('deployment');
      expect(body.override).toBeNull();
    });

    it('returns the tenant override when present', async () => {
      const seed: TenantRecord = {
        id: 'tenant-a',
        quotaBytes: 1000,
        storageThresholds: [0.5, 0.95],
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      };
      const { data } = makeMemoryAdapter({
        [`${TENANTS_COLLECTION}::tenant-a`]: seed,
      });
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['tenants.read'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'get',
        '/v1/tenants/tenant-a/storage/thresholds'
      );
      expect(status).toBe(200);
      expect(body.thresholds).toEqual([0.5, 0.95]);
      expect(body.source).toBe('tenant');
    });
  });

  describe('PUT /:tenantId/storage/thresholds', () => {
    it('401 when no auth context is present', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data);
      const { status } = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/storage/thresholds',
        { thresholds: [0.5] }
      );
      expect(status).toBe(401);
    });

    it('403 without tenants.write scope', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['tenants.read'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/storage/thresholds',
        { thresholds: [0.5] }
      );
      expect(status).toBe(403);
      expect(body.missing).toEqual(['tenants.write']);
    });

    it('400 when thresholds field is missing', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['tenants.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/storage/thresholds',
        {}
      );
      expect(status).toBe(400);
      expect(body.error.code).toBe('INVALID_BODY');
    });

    it('400 when thresholds is null (use DELETE instead)', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['tenants.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/storage/thresholds',
        { thresholds: null }
      );
      expect(status).toBe(400);
      expect(body.error.message).toMatch(/DELETE/);
    });

    it('400 when an entry is out of range', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['tenants.write'],
        } satisfies FakeTenant;
      });
      const r1 = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/storage/thresholds',
        { thresholds: [0.5, 2.0] }
      );
      expect(r1.status).toBe(400);

      const r2 = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/storage/thresholds',
        { thresholds: [0, 0.5] }
      );
      expect(r2.status).toBe(400);

      const r3 = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/storage/thresholds',
        { thresholds: [-0.1, 0.5] }
      );
      expect(r3.status).toBe(400);
    });

    it('400 when more than 8 entries are submitted', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['tenants.write'],
        } satisfies FakeTenant;
      });
      const { status } = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/storage/thresholds',
        { thresholds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] }
      );
      expect(status).toBe(400);
    });

    it('writes a valid override and returns the normalized list', async () => {
      const { data, store } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['tenants.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/storage/thresholds',
        { thresholds: [0.8, 0.5, 0.95, 1.2] }
      );
      expect(status).toBe(200);
      expect(body.override).toEqual([0.5, 0.8, 0.95, 1.2]);
      expect(body.thresholds).toEqual([0.5, 0.8, 0.95, 1.2]);
      expect(body.source).toBe('tenant');

      // Persisted to the tenant record.
      const persisted = store
        .get(TENANTS_COLLECTION)
        ?.get('tenant-a') as TenantRecord | undefined;
      expect(persisted?.storageThresholds).toEqual([0.5, 0.8, 0.95, 1.2]);
    });

    it('allows values above 1.0 (overage alerting)', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['tenants.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/storage/thresholds',
        { thresholds: [1.0, 1.1, 1.5] }
      );
      expect(status).toBe(200);
      expect(body.override).toEqual([1.0, 1.1, 1.5]);
    });
  });

  describe('DELETE /:tenantId/storage/thresholds', () => {
    it('reverts to defaults', async () => {
      const seed: TenantRecord = {
        id: 'tenant-a',
        quotaBytes: 1000,
        storageThresholds: [0.5],
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      };
      const { data, store } = makeMemoryAdapter({
        [`${TENANTS_COLLECTION}::tenant-a`]: seed,
      });
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['tenants.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'delete',
        '/v1/tenants/tenant-a/storage/thresholds'
      );
      expect(status).toBe(200);
      expect(body.override).toBeNull();
      expect(body.thresholds).toEqual([...DEFAULT_STORAGE_THRESHOLDS]);

      const persisted = store
        .get(TENANTS_COLLECTION)
        ?.get('tenant-a') as TenantRecord | undefined;
      expect(persisted?.storageThresholds).toBeNull();
    });
  });
});
