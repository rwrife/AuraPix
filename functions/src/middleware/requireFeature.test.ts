import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { createRequireFeature } from './requireFeature.js';
import {
  TENANT_FEATURES_CONFIG_COLLECTION,
  type TenantFeaturesConfigRecord,
} from '../models/TenantFeaturesConfig.js';
import { __resetTenantFeaturesCacheForTests } from '../services/host/tenantFeaturesConfigService.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../services/metering/MeteringBus.js';
import { setMeteringBus } from '../services/metering/index.js';

class CapturingSink implements MeteringSink {
  events: NormalizedMeteringEvent[] = [];
  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

function makeMemoryAdapter(
  seed?: TenantFeaturesConfigRecord
): { data: DataAdapter; store: Map<string, Map<string, unknown>> } {
  const store = new Map<string, Map<string, unknown>>();
  if (seed) {
    const inner = new Map<string, unknown>();
    inner.set(seed.tenantId, seed);
    store.set(TENANT_FEATURES_CONFIG_COLLECTION, inner);
  }
  const get = (collection: string) => {
    let inner = store.get(collection);
    if (!inner) {
      inner = new Map();
      store.set(collection, inner);
    }
    return inner;
  };
  const adapter: DataAdapter = {
    storeData: vi.fn(async (collection: string, id: string, value: unknown) => {
      get(collection).set(id, value);
    }),
    fetchData: vi.fn(async <T>(collection: string, id: string) => {
      const value = get(collection).get(id);
      return (value ?? null) as T | null;
    }),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(async () => {}),
    deleteData: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => null),
  } as unknown as DataAdapter;
  return { data: adapter, store };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    path: '/v1/photos/abc/export',
    params: {},
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockImplementation(() => ({ json }));
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

describe('requireFeature middleware', () => {
  let sink: CapturingSink;
  let bus: MeteringBus;

  beforeEach(() => {
    __resetTenantFeaturesCacheForTests();
    sink = new CapturingSink();
    bus = new MeteringBus({ sink, flushIntervalMs: 5 });
    setMeteringBus(bus);
  });

  afterEach(() => {
    setMeteringBus(null);
  });

  it('default-on: passes through when the tenant has no config doc', async () => {
    const { data } = makeMemoryAdapter();
    const requireFeature = createRequireFeature(data);
    const mw = requireFeature('export');

    const req = makeReq({ tenant: { id: 'tenant-fresh', scopes: [], keyId: 'k1' } } as Partial<Request>);
    const { res, status } = makeRes();
    const next = vi.fn() as NextFunction;

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('returns 403 with feature_disabled when the flag is off', async () => {
    const seed: TenantFeaturesConfigRecord = {
      tenantId: 'tenant-gated',
      flags: { export: false },
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    };
    const { data } = makeMemoryAdapter(seed);
    const requireFeature = createRequireFeature(data);
    const mw = requireFeature('export');

    const req = makeReq({ tenant: { id: 'tenant-gated', scopes: [], keyId: 'k1' } } as Partial<Request>);
    const { res, status, json } = makeRes();
    const next = vi.fn() as NextFunction;

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: 'feature_disabled',
      feature: 'export',
    });
  });

  it('emits a `feature.gated` metering event on rejection', async () => {
    const seed: TenantFeaturesConfigRecord = {
      tenantId: 'tenant-gated',
      flags: { sharing: false },
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    };
    const { data } = makeMemoryAdapter(seed);
    const requireFeature = createRequireFeature(data);
    const mw = requireFeature('sharing');

    const req = makeReq({
      tenant: { id: 'tenant-gated', scopes: [], keyId: 'k1' },
      user: { uid: 'u_42' },
    } as Partial<Request>);
    const { res } = makeRes();
    const next = vi.fn() as NextFunction;

    await mw(req, res, next);
    await bus.flush();

    const gated = sink.events.filter((e) => e.type === 'feature.gated');
    expect(gated).toHaveLength(1);
    expect(gated[0]).toMatchObject({
      tenantId: 'tenant-gated',
      type: 'feature.gated',
      count: 1,
    });
    expect(gated[0]?.meta).toMatchObject({
      feature: 'sharing',
      userId: 'u_42',
    });
  });

  it('fails open when the data adapter throws', async () => {
    const data: DataAdapter = {
      fetchData: vi.fn(async () => {
        throw new Error('boom');
      }),
      storeData: vi.fn(),
      queryData: vi.fn(async () => []),
      updateData: vi.fn(async () => {}),
      deleteData: vi.fn(async () => {}),
      exists: vi.fn(async () => false),
      listIds: vi.fn(async () => []),
      getPhoto: vi.fn(async () => null),
    } as unknown as DataAdapter;
    const requireFeature = createRequireFeature(data);
    const mw = requireFeature('export');

    const req = makeReq({ tenant: { id: 'tenant-broken', scopes: [], keyId: 'k1' } } as Partial<Request>);
    const { res, status } = makeRes();
    const next = vi.fn() as NextFunction;

    await mw(req, res, next);

    // Adapter exploded; we still let the request through.
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('no-ops when no tenant context can be resolved', async () => {
    const { data } = makeMemoryAdapter();
    const requireFeature = createRequireFeature(data);
    const mw = requireFeature('export');

    const req = makeReq(); // no tenant, no user, no params
    const { res, status } = makeRes();
    const next = vi.fn() as NextFunction;

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });
});
