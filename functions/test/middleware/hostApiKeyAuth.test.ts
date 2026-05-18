import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { DataAdapter, QueryFilter } from '../../src/adapters/data/DataAdapter.js';
import {
  createHostApiKeyAuth,
  requireUserOrTenantScopes,
} from '../../src/middleware/hostApiKeyAuth.js';
import { createTenantApiKey } from '../../src/services/host/tenantApiKeyService.js';

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
      return col(c).get(id) ?? null;
    },
    async queryData<T>(c: string, filters: QueryFilter[]): Promise<T[]> {
      const all = Array.from(col(c).values());
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

function mockRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe('hostApiKeyAuth middleware', () => {
  let adapter: ReturnType<typeof createInMemoryAdapter>;
  let middleware: ReturnType<typeof createHostApiKeyAuth>;

  beforeEach(() => {
    adapter = createInMemoryAdapter();
    middleware = createHostApiKeyAuth(adapter);
  });

  it('is a no-op when no Authorization header is present', async () => {
    const req = { headers: {}, path: '/x' } as unknown as Request;
    const res = mockRes();
    const next: NextFunction = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.tenant).toBeUndefined();
  });

  it('is a no-op when Bearer token is not a host API key', async () => {
    const req = {
      headers: { authorization: 'Bearer firebase-id-token-xyz' },
      path: '/x',
    } as unknown as Request;
    const res = mockRes();
    const next: NextFunction = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.tenant).toBeUndefined();
    expect((res.status as any).mock?.calls ?? []).toHaveLength(0);
  });

  it('sets req.tenant on a valid key', async () => {
    const created = await createTenantApiKey(adapter, {
      tenantId: 'tenant-a',
      scopes: ['usage.read'],
    });
    const req = {
      headers: { authorization: `Bearer ${created.plaintextSecret}` },
      path: '/internal/storage-usage/lib-1',
    } as unknown as Request;
    const res = mockRes();
    const next: NextFunction = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.tenant).toEqual({
      id: 'tenant-a',
      scopes: ['usage.read'],
      keyId: created.record.id,
    });
  });

  it('rejects an unknown key with 401', async () => {
    const req = {
      headers: { authorization: 'Bearer ak_live_not-a-real-key-xxxxxxxxxxxxxxxxxxxx' },
      path: '/internal/anything',
    } as unknown as Request;
    const res = mockRes();
    const next: NextFunction = vi.fn();
    await middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a revoked key with 401', async () => {
    const created = await createTenantApiKey(adapter, {
      tenantId: 'tenant-a',
      scopes: ['usage.read'],
    });
    // Mark as revoked in-place.
    const rec = adapter.store
      .get('tenantApiKeys')!
      .get(created.record.id);
    rec.revokedAt = new Date().toISOString();
    const req = {
      headers: { authorization: `Bearer ${created.plaintextSecret}` },
      path: '/x',
    } as unknown as Request;
    const res = mockRes();
    const next: NextFunction = vi.fn();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireUserOrTenantScopes', () => {
  it('allows a logged-in user even without tenant scopes', () => {
    const guard = requireUserOrTenantScopes({ scopes: ['usage.read'] });
    const req = { user: { uid: 'u1' } } as unknown as Request;
    const res = mockRes();
    const next: NextFunction = vi.fn();
    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a tenant with the required scope', () => {
    const guard = requireUserOrTenantScopes({ scopes: ['usage.read'] });
    const req = {
      tenant: { id: 'tenant-a', scopes: ['usage.read'], keyId: 'k1' },
    } as unknown as Request;
    const res = mockRes();
    const next: NextFunction = vi.fn();
    guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a tenant missing the required scope with 403', () => {
    const guard = requireUserOrTenantScopes({ scopes: ['usage.read'] });
    const req = {
      tenant: { id: 'tenant-a', scopes: ['tenants.read'], keyId: 'k1' },
    } as unknown as Request;
    const res = mockRes();
    const next: NextFunction = vi.fn();
    guard(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant access with 403', () => {
    const guard = requireUserOrTenantScopes({
      scopes: ['usage.read'],
      tenantIdFromReq: () => 'tenant-b',
    });
    const req = {
      tenant: { id: 'tenant-a', scopes: ['usage.read'], keyId: 'k1' },
    } as unknown as Request;
    const res = mockRes();
    const next: NextFunction = vi.fn();
    guard(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.json as any).mock.calls[0][0]).toEqual({
      error: 'Cross-tenant request rejected',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests with 401', () => {
    const guard = requireUserOrTenantScopes({ scopes: ['usage.read'] });
    const req = {} as unknown as Request;
    const res = mockRes();
    const next: NextFunction = vi.fn();
    guard(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
