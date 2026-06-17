import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBulkBatchRateLimiter,
  createBulkPhotosHandler,
} from './batch.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import {
  MeteringBus,
  type NormalizedMeteringEvent,
} from '../../services/metering/MeteringBus.js';
import { setMeteringBus } from '../../services/metering/index.js';

// ---- Test helpers ----

interface FakeRes {
  statusCode: number;
  jsonBody?: unknown;
  headers: Record<string, string>;
  status: (n: number) => FakeRes;
  json: (b: unknown) => FakeRes;
  setHeader: (k: string, v: string) => void;
}

function mkRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    status(n) {
      this.statusCode = n;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
  };
  return res;
}

function mkAdapter(
  store: Record<string, { tenantId?: string; tags?: string[]; albumId?: string }>
): DataAdapter {
  return {
    storeData: vi.fn(async () => undefined),
    fetchData: vi.fn(async (_c: string, id: string) =>
      (store[id] as unknown) ?? null
    ),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(async (_c: string, id: string, updates: any) => {
      if (store[id]) Object.assign(store[id], updates);
    }) as any,
    deleteData: vi.fn(async (_c: string, id: string) => {
      delete store[id];
    }),
    exists: vi.fn(async () => true),
    listIds: vi.fn(async () => Object.keys(store)),
    getPhoto: vi.fn(async (_l: string, id: string) =>
      (store[id] as unknown) ?? null
    ),
  } as unknown as DataAdapter;
}

class CapturingSink {
  events: NormalizedMeteringEvent[] = [];
  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

describe('POST /api/v1/photos:batch', () => {
  let sink: CapturingSink;

  beforeEach(() => {
    clearBulkBatchRateLimiter();
    sink = new CapturingSink();
    setMeteringBus(
      new MeteringBus({ sink, maxBatchSize: 1, flushIntervalMs: 1 })
    );
    // reset envs that may leak across tests
    delete process.env.BULK_PHOTOS_BATCH_MAX;
    delete process.env.BULK_PHOTOS_RATE_LIMIT_PER_SEC;
  });

  function mkReq(body: any, opts: { tenantId?: string; uid?: string } = {}): any {
    return {
      body,
      user: { uid: opts.uid ?? 'user-1' },
      tenantId: opts.tenantId ?? 'tenant-a',
      query: {},
    };
  }

  it('401 when unauthenticated', async () => {
    const handler = createBulkPhotosHandler({ dataAdapter: mkAdapter({}) });
    const res = mkRes();
    await handler({ body: {}, query: {}, tenantId: 'tenant-a' } as any, res as any);
    expect(res.statusCode).toBe(401);
  });

  it('400 on invalid action', async () => {
    const handler = createBulkPhotosHandler({ dataAdapter: mkAdapter({}) });
    const res = mkRes();
    await handler(
      mkReq({ action: 'nope', photoIds: ['p1'] }),
      res as any
    );
    expect(res.statusCode).toBe(400);
    expect((res.jsonBody as any).error.code).toBe('invalid_action');
  });

  it('400 when move action missing albumId', async () => {
    const handler = createBulkPhotosHandler({ dataAdapter: mkAdapter({}) });
    const res = mkRes();
    await handler(mkReq({ action: 'move', photoIds: ['p1'] }), res as any);
    expect(res.statusCode).toBe(400);
    expect((res.jsonBody as any).error.code).toBe('invalid_params');
  });

  it('413 when batch exceeds cap', async () => {
    process.env.BULK_PHOTOS_BATCH_MAX = '3';
    const handler = createBulkPhotosHandler({ dataAdapter: mkAdapter({}) });
    const res = mkRes();
    await handler(
      mkReq({ action: 'delete', photoIds: ['a', 'b', 'c', 'd'] }),
      res as any
    );
    expect(res.statusCode).toBe(413);
    expect((res.jsonBody as any).error.code).toBe('batch_too_large');
  });

  it('400 cross_tenant_reference when any id belongs to another tenant', async () => {
    const store = {
      p1: { tenantId: 'tenant-a' },
      p2: { tenantId: 'tenant-b' }, // foreign
    };
    const handler = createBulkPhotosHandler({
      dataAdapter: mkAdapter(store),
      tenantOfPhoto: async (id) =>
        (store as any)[id]?.tenantId ?? null,
    });
    const res = mkRes();
    await handler(
      mkReq({ action: 'delete', photoIds: ['p1', 'p2'] }),
      res as any
    );
    expect(res.statusCode).toBe(400);
    expect((res.jsonBody as any).error.code).toBe('cross_tenant_reference');
    // Whole batch rejected: p1 not deleted.
    expect(store.p1).toBeDefined();
  });

  it('deletes all ids and returns per-id result array', async () => {
    const store: Record<string, any> = {
      p1: { tenantId: 'tenant-a' },
      p2: { tenantId: 'tenant-a' },
    };
    const handler = createBulkPhotosHandler({
      dataAdapter: mkAdapter(store),
      tenantOfPhoto: async (id) => store[id]?.tenantId ?? null,
    });
    const res = mkRes();
    await handler(
      mkReq({ action: 'delete', photoIds: ['p1', 'p2'] }),
      res as any
    );
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as any;
    expect(body.requested).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: any) => r.ok)).toBe(true);
    expect(store.p1).toBeUndefined();
    expect(store.p2).toBeUndefined();
  });

  it('reports partial failures without aborting the batch', async () => {
    const store: Record<string, any> = {
      p1: { tenantId: 'tenant-a' },
      p2: { tenantId: 'tenant-a' },
    };
    const adapter = mkAdapter(store);
    // Make delete fail for p1 only.
    (adapter.deleteData as any) = vi.fn(async (_c: string, id: string) => {
      if (id === 'p1') throw new Error('boom');
      delete store[id];
    });
    const handler = createBulkPhotosHandler({
      dataAdapter: adapter,
      tenantOfPhoto: async (id) => store[id]?.tenantId ?? null,
    });
    const res = mkRes();
    await handler(
      mkReq({ action: 'delete', photoIds: ['p1', 'p2'] }),
      res as any
    );
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as any;
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    const p1 = body.results.find((r: any) => r.id === 'p1');
    const p2 = body.results.find((r: any) => r.id === 'p2');
    expect(p1.ok).toBe(false);
    expect(p1.error).toBe('boom');
    expect(p2.ok).toBe(true);
  });

  it('emits exactly one bulk.batch metering event per call', async () => {
    const store: Record<string, any> = {
      p1: { tenantId: 'tenant-a' },
      p2: { tenantId: 'tenant-a' },
    };
    const handler = createBulkPhotosHandler({
      dataAdapter: mkAdapter(store),
      tenantOfPhoto: async (id) => store[id]?.tenantId ?? null,
    });
    const res = mkRes();
    await handler(
      mkReq({ action: 'delete', photoIds: ['p1', 'p2'] }),
      res as any
    );
    // Flush.
    await (await import('../../services/metering/index.js'))
      .getMeteringBus()
      .flush();
    const bulk = sink.events.filter((e) => e.type === 'bulk.batch');
    expect(bulk).toHaveLength(1);
    expect(bulk[0]!.tenantId).toBe('tenant-a');
    expect(bulk[0]!.meta).toMatchObject({
      action: 'delete',
      requested: 2,
      succeeded: 2,
      failed: 0,
    });
  });

  it('addTag and removeTag update photo tags', async () => {
    const store: Record<string, any> = {
      p1: { tenantId: 'tenant-a', tags: ['existing'] },
    };
    const handler = createBulkPhotosHandler({
      dataAdapter: mkAdapter(store),
      tenantOfPhoto: async (id) => store[id]?.tenantId ?? null,
    });
    let res = mkRes();
    await handler(
      mkReq({
        action: 'addTag',
        photoIds: ['p1'],
        params: { tag: 'fresh' },
      }),
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(store.p1.tags).toEqual(['existing', 'fresh']);

    res = mkRes();
    await handler(
      mkReq({
        action: 'removeTag',
        photoIds: ['p1'],
        params: { tag: 'existing' },
      }),
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(store.p1.tags).toEqual(['fresh']);
  });

  it('429 when tenant exceeds rate limit', async () => {
    process.env.BULK_PHOTOS_RATE_LIMIT_PER_SEC = '2';
    const store: Record<string, any> = { p1: { tenantId: 'tenant-a' } };
    const handler = createBulkPhotosHandler({
      dataAdapter: mkAdapter(store),
      tenantOfPhoto: async () => 'tenant-a',
    });
    for (let i = 0; i < 2; i++) {
      const res = mkRes();
      await handler(
        mkReq({ action: 'delete', photoIds: ['p1'] }),
        res as any
      );
      // First two succeed (200) or no-op delete (still 200).
      expect([200, 429]).toContain(res.statusCode);
    }
    const res3 = mkRes();
    await handler(
      mkReq({ action: 'delete', photoIds: ['p1'] }),
      res3 as any
    );
    expect(res3.statusCode).toBe(429);
    expect(res3.headers['Retry-After']).toBeDefined();
  });
});
