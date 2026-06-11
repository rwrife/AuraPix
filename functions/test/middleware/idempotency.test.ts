/**
 * Unit tests for the Idempotency-Key middleware (issue #162).
 *
 * Covers the acceptance criteria from the issue:
 *   - First request executes normally and caches the response.
 *   - Same key + same body within TTL replays cached response and does NOT
 *     re-trigger the handler or metering.
 *   - Same key + different body returns 409 IDEMPOTENCY_KEY_CONFLICT.
 *   - Records expire after TTL (re-execution after expiry).
 *   - Metering events are NOT re-emitted on cached replays.
 *   - Tenant isolation: identical keys for different tenants do not collide.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import type {
  DataAdapter,
  QueryFilter,
} from '../../src/adapters/data/DataAdapter.js';
import {
  IDEMPOTENCY_COLLECTION,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  IDEMPOTENCY_CONFLICT_CODE,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  buildRecordId,
  createIdempotencyMiddleware,
  defaultResolveTenantId,
  getNormalizedIdempotencyKey,
  hashRequestBody,
  isExpired,
  IdempotencyKeyTooLongError,
  type IdempotencyRecord,
} from '../../src/middleware/idempotency.js';
import {
  setMeteringBus,
  emitMeteringEvent,
} from '../../src/services/metering/index.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../../src/services/metering/MeteringBus.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
      col(c).set(id, JSON.parse(JSON.stringify(d)));
    },
    async fetchData(c, id) {
      const v = col(c).get(id);
      return v ? JSON.parse(JSON.stringify(v)) : null;
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

/**
 * Build a mock Response that supports the subset of methods the middleware
 * touches (`status`, `json`, `send`, `setHeader`, `getHeader`, `on('finish')`).
 * `whenFinished` is a promise that resolves the first time the simulated
 * response stream emits 'finish' — set up at construction time so callers
 * can `await` it even when the emit fires synchronously inside the
 * middleware/handler.
 */
function createMockRes(): Response & {
  _status: number;
  _body: unknown;
  _headers: Record<string, string | number>;
  whenFinished: Promise<void>;
} {
  const emitter = new EventEmitter();
  const headers: Record<string, string | number> = {};
  const whenFinished = new Promise<void>((resolve) => {
    emitter.once('finish', () => resolve());
  });
  const res: any = {
    _status: 200,
    _body: undefined,
    _headers: headers,
    whenFinished,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      // Simulate Express writing the response and the socket flushing.
      queueMicrotask(() => emitter.emit('finish'));
      return this;
    },
    send(body?: unknown) {
      this._body = body ?? null;
      queueMicrotask(() => emitter.emit('finish'));
      return this;
    },
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    on(event: string, fn: () => void) {
      emitter.on(event, fn);
      return this;
    },
  };
  return res as ReturnType<typeof createMockRes>;
}

function buildReq(opts: {
  body?: unknown;
  key?: string;
  user?: { uid: string };
  tenant?: { id: string; scopes: any[]; keyId: string };
}): Request {
  const headers: Record<string, string> = {};
  if (opts.key !== undefined) headers[IDEMPOTENCY_HEADER] = opts.key;
  return {
    headers,
    body: opts.body,
    user: opts.user,
    tenant: opts.tenant,
  } as unknown as Request;
}

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe('getNormalizedIdempotencyKey', () => {
  it('trims whitespace and returns the key', () => {
    expect(getNormalizedIdempotencyKey('  abc-123  ')).toBe('abc-123');
  });

  it('returns null for missing / empty / wrong-typed input', () => {
    expect(getNormalizedIdempotencyKey(undefined)).toBeNull();
    expect(getNormalizedIdempotencyKey('')).toBeNull();
    expect(getNormalizedIdempotencyKey('   ')).toBeNull();
  });

  it('throws when the key exceeds MAX_IDEMPOTENCY_KEY_LENGTH', () => {
    const tooLong = 'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1);
    expect(() => getNormalizedIdempotencyKey(tooLong)).toThrow(
      IdempotencyKeyTooLongError
    );
  });

  it('accepts the exact MAX length boundary', () => {
    const exact = 'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH);
    expect(getNormalizedIdempotencyKey(exact)).toBe(exact);
  });

  it('uses the first value when given an array header', () => {
    expect(getNormalizedIdempotencyKey(['first', 'second'])).toBe('first');
  });
});

describe('hashRequestBody', () => {
  it('is stable across object key order (canonicalization)', () => {
    const a = hashRequestBody({ name: 'My Album', folderId: null });
    const b = hashRequestBody({ folderId: null, name: 'My Album' });
    expect(a).toBe(b);
  });

  it('differs when values differ', () => {
    const a = hashRequestBody({ name: 'A' });
    const b = hashRequestBody({ name: 'B' });
    expect(a).not.toBe(b);
  });

  it('treats undefined and null bodies equivalently', () => {
    expect(hashRequestBody(undefined)).toBe(hashRequestBody(null));
  });

  it('drops undefined values (matches JSON.stringify semantics)', () => {
    const a = hashRequestBody({ name: 'A', extra: undefined });
    const b = hashRequestBody({ name: 'A' });
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    const a = hashRequestBody({ ids: ['a', 'b'] });
    const b = hashRequestBody({ ids: ['b', 'a'] });
    expect(a).not.toBe(b);
  });
});

describe('buildRecordId', () => {
  it('produces a 64-char hex id and is tenant-scoped', () => {
    const a = buildRecordId('tenant-a', 'POST /albums', 'key-1');
    const b = buildRecordId('tenant-b', 'POST /albums', 'key-1');
    expect(a).toHaveLength(64);
    expect(b).toHaveLength(64);
    expect(a).not.toBe(b);
  });

  it('is stable for identical inputs', () => {
    expect(buildRecordId('t', 'r', 'k')).toBe(buildRecordId('t', 'r', 'k'));
  });
});

describe('defaultResolveTenantId', () => {
  it('prefers req.tenant.id over req.user.uid', () => {
    const req = {
      tenant: { id: 'tenant-x' },
      user: { uid: 'user-y' },
    } as unknown as Request;
    expect(defaultResolveTenantId(req)).toBe('tenant-x');
  });

  it('falls back to req.user.uid when no tenant', () => {
    const req = { user: { uid: 'user-y' } } as unknown as Request;
    expect(defaultResolveTenantId(req)).toBe('user-y');
  });

  it('returns null when neither is set', () => {
    expect(defaultResolveTenantId({} as Request)).toBeNull();
  });
});

describe('isExpired', () => {
  it('returns false for a future expiry', () => {
    const rec = {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as IdempotencyRecord;
    expect(isExpired(rec)).toBe(false);
  });

  it('returns true for a past expiry', () => {
    const rec = {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    } as IdempotencyRecord;
    expect(isExpired(rec)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Middleware behavior
// ---------------------------------------------------------------------------

describe('createIdempotencyMiddleware', () => {
  let adapter: ReturnType<typeof createInMemoryAdapter>;
  let middleware: ReturnType<typeof createIdempotencyMiddleware>;

  // Capture metering events so we can assert that cached replays emit
  // ONLY `idempotency.replayed` and never the original billable event.
  let meteringEvents: NormalizedMeteringEvent[];
  let testSink: MeteringSink;

  beforeEach(() => {
    adapter = createInMemoryAdapter();
    middleware = createIdempotencyMiddleware({
      route: 'POST /api/v1/albums',
      dataAdapter: adapter,
    });
    meteringEvents = [];
    testSink = {
      async deliver(events) {
        meteringEvents.push(...events);
      },
    };
    setMeteringBus(
      new MeteringBus({ sink: testSink, maxBatchSize: 1, flushIntervalMs: 1 })
    );
  });

  it('passes through when no Idempotency-Key header is supplied', async () => {
    const req = buildReq({ body: { name: 'A' }, user: { uid: 'u1' } });
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(adapter.store.get(IDEMPOTENCY_COLLECTION)?.size ?? 0).toBe(0);
  });

  it('passes through when no tenant can be resolved', async () => {
    const req = buildReq({ body: { name: 'A' }, key: 'k1' });
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(adapter.store.get(IDEMPOTENCY_COLLECTION)?.size ?? 0).toBe(0);
  });

  it('returns 400 when key exceeds the max length', async () => {
    const req = buildReq({
      body: { name: 'A' },
      key: 'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1),
      user: { uid: 'u1' },
    });
    const res = createMockRes();
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect((res._body as any).error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('first call executes handler and persists a cache record', async () => {
    const req = buildReq({
      body: { name: 'A' },
      key: 'key-1',
      user: { uid: 'u1' },
    });
    const res = createMockRes();
    const next = vi.fn(() => {
      res.status(201).json({ album: { id: 'al-1', name: 'A' } });
    }) as unknown as NextFunction;

    await middleware(req, res, next);
    // Drive the simulated 'finish' to trigger persistence.
    await res.whenFinished;
    // Allow the queued microtask + the async storeData to resolve.
    await new Promise((r) => setImmediate(r));

    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(201);
    expect(res._body).toEqual({ album: { id: 'al-1', name: 'A' } });

    const collection = adapter.store.get(IDEMPOTENCY_COLLECTION);
    expect(collection?.size).toBe(1);
    const recordId = buildRecordId('u1', 'POST /api/v1/albums', 'key-1');
    const record = collection?.get(recordId) as IdempotencyRecord;
    expect(record).toBeDefined();
    expect(record.tenantId).toBe('u1');
    expect(record.key).toBe('key-1');
    expect(record.status).toBe(201);
    expect(record.body).toEqual({ album: { id: 'al-1', name: 'A' } });
    expect(record.bodyHash).toBe(hashRequestBody({ name: 'A' }));
    expect(Date.parse(record.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('replays cached response on retry with same key + same body (no handler re-invocation)', async () => {
    const handler = vi.fn();

    // First call: write to cache.
    const req1 = buildReq({
      body: { name: 'A' },
      key: 'key-2',
      user: { uid: 'u1' },
    });
    const res1 = createMockRes();
    const next1 = vi.fn(() => {
      handler();
      res1.status(201).json({ album: { id: 'al-1', name: 'A' } });
    }) as unknown as NextFunction;
    await middleware(req1, res1, next1);
    await res1.whenFinished;
    await new Promise((r) => setImmediate(r));

    // Second call: should replay without invoking handler.
    const req2 = buildReq({
      body: { name: 'A' },
      key: 'key-2',
      user: { uid: 'u1' },
    });
    const res2 = createMockRes();
    const next2 = vi.fn(() => {
      handler();
    }) as unknown as NextFunction;
    await middleware(req2, res2, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1); // only the first call
    expect(res2._status).toBe(201);
    expect(res2._body).toEqual({ album: { id: 'al-1', name: 'A' } });
    expect(res2._headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe(
      'true'
    );
  });

  it('emits exactly one idempotency.replayed event per cached replay and NOT the original billable event', async () => {
    // First call: handler emits a billable event then responds.
    const req1 = buildReq({
      body: { name: 'A' },
      key: 'key-3',
      user: { uid: 'u1' },
    });
    const res1 = createMockRes();
    const next1 = vi.fn(() => {
      emitMeteringEvent({
        tenantId: 'u1',
        type: 'upload.accepted',
        count: 1,
        bytes: 100,
      });
      res1.status(201).json({ album: { id: 'al-1', name: 'A' } });
    }) as unknown as NextFunction;
    await middleware(req1, res1, next1);
    await res1.whenFinished;
    await new Promise((r) => setImmediate(r));

    // Retry: cached replay. No billable event should fire; one
    // `idempotency.replayed` event should be observable.
    const req2 = buildReq({
      body: { name: 'A' },
      key: 'key-3',
      user: { uid: 'u1' },
    });
    const res2 = createMockRes();
    await middleware(req2, res2, vi.fn() as unknown as NextFunction);

    // Flush both events through the test sink.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const types = meteringEvents.map((e) => e.type);
    expect(types).toContain('upload.accepted');
    expect(types).toContain('idempotency.replayed');
    expect(types.filter((t) => t === 'upload.accepted')).toHaveLength(1);
    expect(types.filter((t) => t === 'idempotency.replayed')).toHaveLength(1);

    const replayed = meteringEvents.find(
      (e) => e.type === 'idempotency.replayed'
    );
    expect(replayed?.tenantId).toBe('u1');
    expect(replayed?.meta).toMatchObject({
      route: 'POST /api/v1/albums',
      key: 'key-3',
    });
  });

  it('returns 409 IDEMPOTENCY_KEY_CONFLICT when same key is reused with a different body', async () => {
    const req1 = buildReq({
      body: { name: 'A' },
      key: 'key-4',
      user: { uid: 'u1' },
    });
    const res1 = createMockRes();
    await middleware(req1, res1, vi.fn(() => {
      res1.status(201).json({ album: { id: 'al-1' } });
    }) as unknown as NextFunction);
    await res1.whenFinished;
    await new Promise((r) => setImmediate(r));

    // Conflicting body, same key.
    const req2 = buildReq({
      body: { name: 'B' },
      key: 'key-4',
      user: { uid: 'u1' },
    });
    const res2 = createMockRes();
    const next2 = vi.fn() as unknown as NextFunction;
    await middleware(req2, res2, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res2._status).toBe(409);
    expect((res2._body as any).error.code).toBe(IDEMPOTENCY_CONFLICT_CODE);
    expect((res2._body as any).error.details).toMatchObject({
      route: 'POST /api/v1/albums',
      key: 'key-4',
    });
  });

  it('re-executes the handler when the cached record has expired', async () => {
    const tenantId = 'u1';
    const route = 'POST /api/v1/albums';
    const key = 'key-5';
    const body = { name: 'A' };
    const recordId = buildRecordId(tenantId, route, key);

    // Pre-populate an expired record.
    const expired: IdempotencyRecord = {
      key,
      tenantId,
      route,
      bodyHash: hashRequestBody(body),
      status: 201,
      body: { album: { id: 'stale' } },
      headers: {},
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await adapter.storeData(IDEMPOTENCY_COLLECTION, recordId, expired);

    const req = buildReq({ body, key, user: { uid: tenantId } });
    const res = createMockRes();
    const next = vi.fn(() => {
      res.status(201).json({ album: { id: 'fresh' } });
    }) as unknown as NextFunction;
    await middleware(req, res, next);
    await res.whenFinished;
    await new Promise((r) => setImmediate(r));

    expect(next).toHaveBeenCalledTimes(1);
    expect((res._body as any).album.id).toBe('fresh');

    const refreshed = (await adapter.fetchData<IdempotencyRecord>(
      IDEMPOTENCY_COLLECTION,
      recordId
    )) as IdempotencyRecord;
    expect(refreshed.body).toEqual({ album: { id: 'fresh' } });
    expect(Date.parse(refreshed.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('does NOT cache non-2xx responses', async () => {
    const req = buildReq({
      body: { name: '' },
      key: 'key-6',
      user: { uid: 'u1' },
    });
    const res = createMockRes();
    const next = vi.fn(() => {
      res.status(400).json({ error: { code: 'INVALID_BODY' } });
    }) as unknown as NextFunction;
    await middleware(req, res, next);
    await res.whenFinished;
    await new Promise((r) => setImmediate(r));

    expect(adapter.store.get(IDEMPOTENCY_COLLECTION)?.size ?? 0).toBe(0);
  });

  it('isolates idempotency keys across tenants (same key, different tenant)', async () => {
    // Tenant A writes a record.
    const reqA = buildReq({
      body: { name: 'A' },
      key: 'shared-key',
      user: { uid: 'tenant-a' },
    });
    const resA = createMockRes();
    await middleware(reqA, resA, vi.fn(() => {
      resA.status(201).json({ owner: 'A' });
    }) as unknown as NextFunction);
    await resA.whenFinished;
    await new Promise((r) => setImmediate(r));

    // Tenant B with the SAME key + a different body must NOT hit
    // tenant A's cached record (no 409, no replay; handler runs).
    const reqB = buildReq({
      body: { name: 'B' },
      key: 'shared-key',
      user: { uid: 'tenant-b' },
    });
    const resB = createMockRes();
    const nextB = vi.fn(() => {
      resB.status(201).json({ owner: 'B' });
    }) as unknown as NextFunction;
    await middleware(reqB, resB, nextB);
    await resB.whenFinished;
    await new Promise((r) => setImmediate(r));

    expect(nextB).toHaveBeenCalledTimes(1);
    expect((resB._body as any).owner).toBe('B');
    expect(resB._status).toBe(201);
    expect(adapter.store.get(IDEMPOTENCY_COLLECTION)?.size).toBe(2);
  });

  it('uses req.tenant.id (host API key) when present, in preference to req.user.uid', async () => {
    const req = buildReq({
      body: { name: 'A' },
      key: 'key-7',
      user: { uid: 'user-uid' },
      tenant: { id: 'tenant-via-key', scopes: [], keyId: 'k1' },
    });
    const res = createMockRes();
    await middleware(req, res, vi.fn(() => {
      res.status(201).json({ ok: true });
    }) as unknown as NextFunction);
    await res.whenFinished;
    await new Promise((r) => setImmediate(r));

    const expectedId = buildRecordId(
      'tenant-via-key',
      'POST /api/v1/albums',
      'key-7'
    );
    const collection = adapter.store.get(IDEMPOTENCY_COLLECTION)!;
    expect(collection.has(expectedId)).toBe(true);
  });

  it('falls through when the store lookup throws (degrade gracefully)', async () => {
    const brokenAdapter: DataAdapter = {
      ...adapter,
      async fetchData() {
        throw new Error('firestore unavailable');
      },
    };
    const brokenMiddleware = createIdempotencyMiddleware({
      route: 'POST /api/v1/albums',
      dataAdapter: brokenAdapter,
    });

    const req = buildReq({
      body: { name: 'A' },
      key: 'key-8',
      user: { uid: 'u1' },
    });
    const res = createMockRes();
    const next = vi.fn(() => {
      res.status(201).json({ ok: true });
    }) as unknown as NextFunction;
    await brokenMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(201);
  });
});
