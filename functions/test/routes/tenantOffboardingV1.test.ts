/**
 * HTTP-level tests for tenant offboarding routes (issue #155).
 *
 *  - 401 without host key
 *  - 403 cross-tenant
 *  - 403 missing tenant.admin scope
 *  - 202 on POST /export with the right scope
 *  - DELETE requires matching X-Confirm-Tenant-Id
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type { DataAdapter, QueryFilter } from '../../src/adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../../src/adapters/storage/StorageAdapter.js';
import { TenantOffboardingService } from '../../src/services/tenant/TenantOffboardingService.js';
import { createTenantOffboardingRouter } from '../../src/routes/tenantOffboardingV1.js';
import type { TenantApiKeyScope } from '../../src/models/TenantApiKey.js';

class MemData implements DataAdapter {
  collections: Map<string, Map<string, any>> = new Map();
  async storeData<T>(c: string, id: string, data: T): Promise<void> {
    if (!this.collections.has(c)) this.collections.set(c, new Map());
    this.collections.get(c)!.set(id, JSON.parse(JSON.stringify(data)));
  }
  async fetchData<T>(c: string, id: string): Promise<T | null> {
    return (this.collections.get(c)?.get(id) as T) ?? null;
  }
  async queryData<T>(c: string, filters: QueryFilter[]): Promise<T[]> {
    const col = this.collections.get(c);
    if (!col) return [];
    return [...col.values()].filter((doc) =>
      filters.every((f) => {
        const v = (doc as any)[f.field];
        return f.operator === '==' ? v === f.value : false;
      })
    );
  }
  async updateData<T>(c: string, id: string, updates: Partial<T>): Promise<void> {
    const col = this.collections.get(c);
    if (!col) return;
    const existing = col.get(id) ?? {};
    col.set(id, { ...existing, ...updates });
  }
  async deleteData(c: string, id: string): Promise<void> {
    this.collections.get(c)?.delete(id);
  }
  async exists(c: string, id: string): Promise<boolean> {
    return !!this.collections.get(c)?.has(id);
  }
  async listIds(c: string): Promise<string[]> {
    return [...(this.collections.get(c)?.keys() ?? [])];
  }
  async getPhoto(): Promise<any | null> {
    return null;
  }
}

class MemStorage implements StorageAdapter {
  files: Map<string, Buffer> = new Map();
  async storeFile(path: string, data: Buffer): Promise<void> {
    this.files.set(path, Buffer.from(data));
  }
  async readFile(path: string): Promise<Buffer> {
    return this.files.get(path) ?? Buffer.alloc(0);
  }
  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }
  async listFiles(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix));
  }
  async getSignedUrl(): Promise<string> {
    return 'sig://x';
  }
  async getDownloadUrl(): Promise<string> {
    return 'http://x';
  }
}

interface HttpResult {
  status: number;
  body: any;
}

async function request(
  app: express.Express,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<HttpResult> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const init: RequestInit = {
        method,
        headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      fetch(`http://127.0.0.1:${port}${path}`, init)
        .then(async (res) => {
          const text = await res.text();
          let parsed: any = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          server.close();
          resolve({ status: res.status, body: parsed });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

function makeApp(svc: TenantOffboardingService): express.Express {
  const app = express();
  app.use(express.json());
  // Fake auth: synth req.tenant from headers for test purposes.
  app.use((req, _res, next) => {
    const id = req.header('x-test-tenant');
    const scopes = req.header('x-test-scopes');
    if (id) {
      req.tenant = {
        id,
        scopes: ((scopes ?? '').split(',').filter(Boolean) as TenantApiKeyScope[]),
        keyId: 'k1',
      };
    }
    next();
  });
  app.use('/api/v1/tenants', createTenantOffboardingRouter({ service: svc }));
  return app;
}

describe('tenant offboarding routes', () => {
  let svc: TenantOffboardingService;
  let app: express.Express;
  let data: MemData;

  beforeEach(() => {
    data = new MemData();
    svc = new TenantOffboardingService({ data, storage: new MemStorage() });
    app = makeApp(svc);
  });

  it('401 without host key', async () => {
    const res = await request(app, 'POST', '/api/v1/tenants/t1/export');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('HOST_KEY_REQUIRED');
  });

  it('403 cross-tenant', async () => {
    const res = await request(app, 'POST', '/api/v1/tenants/t1/export', {
      headers: { 'x-test-tenant': 't2', 'x-test-scopes': 'tenant.admin' },
    });
    expect(res.status).toBe(403);
  });

  it('403 missing tenant.admin scope', async () => {
    const res = await request(app, 'POST', '/api/v1/tenants/t1/export', {
      headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'usage.read' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('202 on export request with proper scope', async () => {
    const res = await request(app, 'POST', '/api/v1/tenants/t1/export', {
      headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.admin' },
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(res.body.exportId).toMatch(/^exp_/);
  });

  it('DELETE without confirmation header returns 400', async () => {
    const res = await request(app, 'DELETE', '/api/v1/tenants/t1', {
      headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.admin' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('DELETE with mismatched confirmation header returns 400', async () => {
    const res = await request(app, 'DELETE', '/api/v1/tenants/t1', {
      headers: {
        'x-test-tenant': 't1',
        'x-test-scopes': 'tenant.admin',
        'x-confirm-tenant-id': 't2',
      },
    });
    expect(res.status).toBe(400);
  });

  it('DELETE with matching confirmation succeeds', async () => {
    await data.storeData('photos', 'p0', { id: 'p0', tenantId: 't1', bytes: 1 });
    const res = await request(app, 'DELETE', '/api/v1/tenants/t1', {
      headers: {
        'x-test-tenant': 't1',
        'x-test-scopes': 'tenant.admin',
        'x-confirm-tenant-id': 't1',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe('t1');
    expect(res.body.itemsDeleted).toBeGreaterThan(0);
  });
});
