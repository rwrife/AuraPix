import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { TENANT_EXPORT_PRESETS_COLLECTION } from '../models/ExportPreset.js';
import { createTenantExportPresetsRouter } from './tenantExportPresetsV1.js';

interface FakeTenant {
  id: string;
  scopes: string[];
  keyId?: string;
}

function makeApp(
  data: DataAdapter,
  inject: (req: any) => void = () => {}
): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    inject(req);
    next();
  });
  app.use(
    '/v1/tenants',
    createTenantExportPresetsRouter({ dataAdapter: data })
  );
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
  method: 'get' | 'put' | 'delete' | 'post',
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
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

describe('createTenantExportPresetsRouter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /:tenantId/export-presets', () => {
    it('returns 401 when no auth context is present', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data);
      const res = await request(app, 'get', '/v1/tenants/tenant-a/export-presets');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    });

    it('returns the seeded defaults for an unconfigured tenant (host key)', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        req.tenant = {
          id: 'tenant-a',
          scopes: ['export-presets.read'],
          keyId: 'tak_x',
        } satisfies FakeTenant;
      });
      const res = await request(app, 'get', '/v1/tenants/tenant-a/export-presets');
      expect(res.status).toBe(200);
      expect(res.body.tenantId).toBe('tenant-a');
      const names = res.body.presets.map((p: any) => p.name).sort();
      expect(names).toEqual(['original', 'web-large', 'web-small']);
      expect(res.body.updatedBy).toBe(null);
    });

    it('allows an authenticated user to read presets (no host key)', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        req.user = { uid: 'u_1' };
      });
      const res = await request(app, 'get', '/v1/tenants/tenant-a/export-presets');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.presets)).toBe(true);
      expect(res.body.presets.length).toBeGreaterThan(0);
    });

    it('rejects cross-tenant host-key reads with 403', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        req.tenant = {
          id: 'tenant-other',
          scopes: ['export-presets.read'],
          keyId: 'tak_x',
        };
      });
      const res = await request(app, 'get', '/v1/tenants/tenant-a/export-presets');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CROSS_TENANT_FORBIDDEN');
    });

    it('rejects host-key reads without the read scope with 403', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        req.tenant = { id: 'tenant-a', scopes: [], keyId: 'tak_x' };
      });
      const res = await request(app, 'get', '/v1/tenants/tenant-a/export-presets');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
    });
  });

  describe('PUT /:tenantId/export-presets/:name', () => {
    function hostKeyApp(scopes: string[] = ['export-presets.write']) {
      const { data, store } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        req.tenant = { id: 'tenant-a', scopes, keyId: 'tak_x' };
      });
      return { app, data, store };
    }

    it('requires a host API key (a user token is not enough)', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        req.user = { uid: 'u_1' };
      });
      const res = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/web-small',
        { maxEdge: 1280, quality: 80, format: 'jpeg' }
      );
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('HOST_API_KEY_REQUIRED');
    });

    it('returns 400 on an invalid preset name', async () => {
      const { app } = hostKeyApp();
      const res = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/Has_Capital',
        { maxEdge: 1280, quality: 80, format: 'jpeg' }
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PRESET_NAME');
    });

    it('returns 400 on an out-of-range quality', async () => {
      const { app } = hostKeyApp();
      const res = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/web-small',
        { maxEdge: 1280, quality: 200, format: 'jpeg' }
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_QUALITY');
    });

    it('returns 400 on an unknown format', async () => {
      const { app } = hostKeyApp();
      const res = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/web-small',
        { maxEdge: 1280, quality: 80, format: 'tiff' }
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_FORMAT');
    });

    it('returns 400 when watermark.opacity is out of [0,1] (issue #185)', async () => {
      const { app } = hostKeyApp();
      const res = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/web-small',
        {
          maxEdge: 1280,
          quality: 80,
          format: 'jpeg',
          watermark: {
            enabled: true,
            text: 'PROOF',
            opacity: 1.5,
            position: 'bottom-right',
          },
        }
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WATERMARK_OPACITY');
    });

    it('returns 400 when watermark.position is unknown (issue #185)', async () => {
      const { app } = hostKeyApp();
      const res = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/web-small',
        {
          maxEdge: 1280,
          quality: 80,
          format: 'jpeg',
          watermark: {
            enabled: true,
            text: 'PROOF',
            opacity: 0.5,
            position: 'middle',
          },
        }
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WATERMARK_POSITION');
    });

    it('returns 400 when watermark.enabled is true but text is blank (issue #185)', async () => {
      const { app } = hostKeyApp();
      const res = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/web-small',
        {
          maxEdge: 1280,
          quality: 80,
          format: 'jpeg',
          watermark: {
            enabled: true,
            text: '   ',
            opacity: 0.5,
            position: 'bottom-right',
          },
        }
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WATERMARK_TEXT');
    });

    it('persists a watermark block when provided (issue #185)', async () => {
      const { app, store } = hostKeyApp();
      const wm = {
        enabled: true,
        text: 'PROOF — {tenantName}',
        opacity: 0.5,
        position: 'bottom-right' as const,
      };
      const res = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/web-large',
        {
          maxEdge: 2048,
          quality: 85,
          format: 'jpeg',
          label: 'Web (large)',
          watermark: wm,
        }
      );
      expect(res.status).toBe(200);
      expect(res.body.preset.watermark).toEqual(wm);
      const persisted: any = store
        .get(TENANT_EXPORT_PRESETS_COLLECTION)
        ?.get('tenant-a');
      const found = persisted.presets.find((p: any) => p.name === 'web-large');
      expect(found.watermark).toEqual(wm);
    });

    it('rejects cross-tenant preset write with 403 (issue #185 AC)', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        req.tenant = {
          id: 'tenant-other',
          scopes: ['export-presets.write'],
          keyId: 'tak_x',
        };
      });
      const res = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/web-small',
        {
          maxEdge: 1280,
          quality: 80,
          format: 'jpeg',
          watermark: {
            enabled: true,
            text: 'PROOF',
            opacity: 0.5,
            position: 'bottom-right',
          },
        }
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CROSS_TENANT_FORBIDDEN');
    });

    it('creates a new preset and reports `changed: true`', async () => {
      const { app, store } = hostKeyApp();
      const res = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/print-a4',
        { maxEdge: 3000, quality: 92, format: 'jpeg', label: 'Print A4' }
      );
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(true);
      expect(res.body.preset).toEqual({
        name: 'print-a4',
        maxEdge: 3000,
        quality: 92,
        format: 'jpeg',
        label: 'Print A4',
      });
      const persisted: any = store
        .get(TENANT_EXPORT_PRESETS_COLLECTION)
        ?.get('tenant-a');
      expect(persisted.updatedBy).toBe('tak_x');
      // The persisted doc should contain seeded defaults + the new preset.
      const names = persisted.presets.map((p: any) => p.name).sort();
      expect(names).toEqual(['original', 'print-a4', 'web-large', 'web-small']);
    });

    it('reports `changed: false` on an idempotent rewrite', async () => {
      const { app } = hostKeyApp();
      const body = { maxEdge: 1280, quality: 80, format: 'jpeg', label: 'Web (small)' };
      // First PUT: the body matches the seeded default `web-small` exactly,
      // so the service short-circuits without persisting. Confirm `changed`
      // is false and a subsequent PUT is also a no-op.
      const first = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/web-small',
        body
      );
      expect(first.body.changed).toBe(false);
      const second = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/web-small',
        body
      );
      expect(second.status).toBe(200);
      expect(second.body.changed).toBe(false);

      // But changing a field should flip `changed: true`.
      const third = await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/web-small',
        { ...body, quality: 75 }
      );
      expect(third.body.changed).toBe(true);
    });
  });

  describe('DELETE /:tenantId/export-presets/:name', () => {
    it('requires a host API key', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        req.user = { uid: 'u_1' };
      });
      const res = await request(
        app,
        'delete',
        '/v1/tenants/tenant-a/export-presets/web-small'
      );
      expect(res.status).toBe(401);
    });

    it('removes an existing preset and reports `removed: true`', async () => {
      const { data, store } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        req.tenant = {
          id: 'tenant-a',
          scopes: ['export-presets.write'],
          keyId: 'tak_x',
        };
      });
      // Seed a doc by PUTting first.
      await request(
        app,
        'put',
        '/v1/tenants/tenant-a/export-presets/print-a4',
        { maxEdge: 3000, quality: 92, format: 'jpeg' }
      );
      const res = await request(
        app,
        'delete',
        '/v1/tenants/tenant-a/export-presets/print-a4'
      );
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(true);
      const persisted: any = store
        .get(TENANT_EXPORT_PRESETS_COLLECTION)
        ?.get('tenant-a');
      expect(persisted.presets.map((p: any) => p.name)).not.toContain('print-a4');
    });

    it('returns `removed: false` for an unknown preset (idempotent)', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        req.tenant = {
          id: 'tenant-a',
          scopes: ['export-presets.write'],
          keyId: 'tak_x',
        };
      });
      const res = await request(
        app,
        'delete',
        '/v1/tenants/tenant-a/export-presets/ghost'
      );
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(false);
    });
  });
});
