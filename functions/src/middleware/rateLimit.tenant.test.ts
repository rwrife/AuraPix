/**
 * Tests for the per-tenant token-bucket rate limiter (issue #154).
 *
 * Acceptance criteria covered:
 *  - Burst above capacity returns 429 + Retry-After.
 *  - Steady traffic at RATE_LIMIT_RPS returns 200 indefinitely.
 *  - Per-tenant override doc is honored without restart.
 *  - Two tenants in parallel: one saturated, the other unaffected.
 *  - rate_limit.exceeded metering event is emitted, sampled to <=1/sec/tenant.
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  clearTokenBuckets,
  createTenantTokenBucketRateLimiter,
  TENANT_CONFIG_COLLECTION,
  type TenantRateLimitConfigDoc,
} from './rateLimit.js';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type {
  UsageMeteringBus,
  UsageMeteringEvent,
  UsageMeteringHandler,
} from '../services/metering/UsageMeteringBus.js';

function makeRes(): Response & { _status?: number; _body?: unknown; _headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    _headers: headers,
    setHeader(name: string, value: string) {
      headers[name] = String(value);
      return this;
    },
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
  } as unknown as Response & { _status?: number; _body?: unknown; _headers: Record<string, string> };
  return res;
}

function makeReq(tenantId: string, opts: { hostKey?: boolean; path?: string } = {}): Request {
  const req: Partial<Request> = {
    tenantId,
    path: opts.path ?? '/api/test',
    headers: {},
  };
  if (opts.hostKey) {
    (req as Request).tenant = { id: tenantId, scopes: [], keyId: 'k1' };
  }
  return req as Request;
}

class CapturingBus implements UsageMeteringBus {
  events: UsageMeteringEvent[] = [];
  private handlers = new Set<UsageMeteringHandler>();
  async publish(event: UsageMeteringEvent): Promise<void> {
    this.events.push(event);
    for (const h of this.handlers) await h(event);
  }
  subscribe(handler: UsageMeteringHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

class StaticOverrideAdapter implements Partial<DataAdapter> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public docs = new Map<string, any>();
  setOverride(tenantId: string, doc: TenantRateLimitConfigDoc | null) {
    if (doc === null) this.docs.delete(`${TENANT_CONFIG_COLLECTION}:${tenantId}`);
    else this.docs.set(`${TENANT_CONFIG_COLLECTION}:${tenantId}`, doc);
  }
  async fetchData<T>(collection: string, id: string): Promise<T | null> {
    return (this.docs.get(`${collection}:${id}`) as T) ?? null;
  }
}

async function runMiddleware(mw: ReturnType<typeof createTenantTokenBucketRateLimiter>, req: Request, res: Response): Promise<{ called: boolean }> {
  let called = false;
  const next: NextFunction = () => {
    called = true;
  };
  await mw(req, res, next);
  return { called };
}

beforeEach(() => {
  clearTokenBuckets();
});

describe('createTenantTokenBucketRateLimiter', () => {
  test('rejects requests over burst capacity with 429 + Retry-After', async () => {
    let nowMs = 1_000_000;
    const mw = createTenantTokenBucketRateLimiter({
      rps: 1,
      burst: 3,
      now: () => nowMs,
    });

    // First 3 (the burst) should succeed.
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      const { called } = await runMiddleware(mw, makeReq('t1'), res);
      expect(called, `req ${i} should pass`).toBe(true);
      expect(res._status).toBeUndefined();
    }

    // 4th request: bucket empty, 429 expected.
    const res = makeRes();
    const { called } = await runMiddleware(mw, makeReq('t1'), res);
    expect(called).toBe(false);
    expect(res._status).toBe(429);
    expect(res._headers['Retry-After']).toBeDefined();
    expect(Number(res._headers['Retry-After'])).toBeGreaterThanOrEqual(1);
    const body = res._body as Record<string, unknown>;
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.statusCode).toBe(429);
    expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  test('steady traffic at rps returns 200 indefinitely (token-bucket steady state)', async () => {
    let nowMs = 0;
    const mw = createTenantTokenBucketRateLimiter({
      rps: 10,
      burst: 10,
      now: () => nowMs,
    });
    // 50 requests, paced at exactly 1/rps = 100ms apart.
    for (let i = 0; i < 50; i++) {
      const res = makeRes();
      const { called } = await runMiddleware(mw, makeReq('steady'), res);
      expect(called, `request ${i} at t=${nowMs} should pass`).toBe(true);
      expect(res._status).toBeUndefined();
      nowMs += 100;
    }
  });

  test('two tenants in parallel: one saturated, the other unaffected', async () => {
    let nowMs = 1_000_000;
    const mw = createTenantTokenBucketRateLimiter({
      rps: 1,
      burst: 2,
      now: () => nowMs,
    });

    // Saturate tenant A.
    for (let i = 0; i < 2; i++) {
      const res = makeRes();
      const { called } = await runMiddleware(mw, makeReq('A'), res);
      expect(called).toBe(true);
    }
    const aRes = makeRes();
    const aOut = await runMiddleware(mw, makeReq('A'), aRes);
    expect(aOut.called).toBe(false);
    expect(aRes._status).toBe(429);

    // Tenant B is unaffected.
    for (let i = 0; i < 2; i++) {
      const res = makeRes();
      const { called } = await runMiddleware(mw, makeReq('B'), res);
      expect(called, `B req ${i} should pass`).toBe(true);
      expect(res._status).toBeUndefined();
    }
  });

  test('per-tenant override doc is honored on next request without restart', async () => {
    let nowMs = 1_000_000;
    const adapter = new StaticOverrideAdapter();
    const mw = createTenantTokenBucketRateLimiter({
      rps: 1,
      burst: 1, // env-level: just 1
      dataAdapter: adapter as unknown as DataAdapter,
      overrideCacheTtlMs: 0, // disable caching so changes apply immediately
      now: () => nowMs,
    });

    // Override: bumps capacity to 5.
    adapter.setOverride('vip', { rateLimit: { rps: 10, burst: 5 } });

    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      const { called } = await runMiddleware(mw, makeReq('vip'), res);
      expect(called, `req ${i} should pass under override`).toBe(true);
    }

    // Remove the override; new effective burst = 1, bucket already drained.
    adapter.setOverride('vip', null);
    const res = makeRes();
    const { called } = await runMiddleware(mw, makeReq('vip'), res);
    expect(called).toBe(false);
    expect(res._status).toBe(429);
  });

  test('emits rate_limit.exceeded sampled to <=1/sec/tenant', async () => {
    let nowMs = 1_000_000;
    const bus = new CapturingBus();
    const mw = createTenantTokenBucketRateLimiter({
      rps: 1,
      burst: 1,
      meteringBus: bus,
      now: () => nowMs,
    });

    // Consume the single token.
    {
      const res = makeRes();
      const { called } = await runMiddleware(mw, makeReq('busy'), res);
      expect(called).toBe(true);
    }

    // 5 rapid overflows within the same second -> only 1 event.
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      const { called } = await runMiddleware(mw, makeReq('busy'), res);
      expect(called).toBe(false);
      expect(res._status).toBe(429);
    }
    // Allow microtasks to flush (publish is fire-and-forget).
    await new Promise((r) => setTimeout(r, 5));
    expect(bus.events.length).toBe(1);
    expect(bus.events[0].counter).toBe('rateLimited');
    expect(bus.events[0].tenantId).toBe('busy');
    expect(bus.events[0].meta?.event).toBe('rate_limit.exceeded');
    expect(bus.events[0].meta?.principal).toBe('user');

    // Advance >1s; bucket refills to ~1 token. Consume it, then overflow
    // again to trigger a fresh event.
    nowMs += 1_500;
    await runMiddleware(mw, makeReq('busy'), makeRes()); // consume refill
    const res2 = makeRes();
    await runMiddleware(mw, makeReq('busy'), res2);
    expect(res2._status).toBe(429);
    await new Promise((r) => setTimeout(r, 5));
    expect(bus.events.length).toBe(2);
  });

  test('host API key traffic uses a separate, higher bucket', async () => {
    let nowMs = 1_000_000;
    const mw = createTenantTokenBucketRateLimiter({
      rps: 1,
      burst: 1,
      hostRps: 100,
      now: () => nowMs,
    });

    // Drain user bucket.
    {
      const res = makeRes();
      const { called } = await runMiddleware(mw, makeReq('t1'), res);
      expect(called).toBe(true);
    }
    // User bucket empty.
    {
      const res = makeRes();
      const { called } = await runMiddleware(mw, makeReq('t1'), res);
      expect(called).toBe(false);
      expect(res._status).toBe(429);
    }
    // Host-key request to the same tenant: separate bucket, passes.
    {
      const res = makeRes();
      const { called } = await runMiddleware(mw, makeReq('t1', { hostKey: true }), res);
      expect(called).toBe(true);
      expect(res._status).toBeUndefined();
    }
  });

  test('passes through when req.tenantId is missing', async () => {
    const mw = createTenantTokenBucketRateLimiter({ rps: 1, burst: 1 });
    const req = { headers: {}, path: '/x' } as unknown as Request;
    const res = makeRes();
    let called = false;
    await mw(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(res._status).toBeUndefined();
  });

  test('config-doc read failure does not block requests', async () => {
    let nowMs = 1_000_000;
    const failing: Partial<DataAdapter> = {
      async fetchData() {
        throw new Error('boom');
      },
    };
    const mw = createTenantTokenBucketRateLimiter({
      rps: 5,
      burst: 5,
      dataAdapter: failing as DataAdapter,
      overrideCacheTtlMs: 0,
      now: () => nowMs,
    });
    const res = makeRes();
    const { called } = await runMiddleware(mw, makeReq('t1'), res);
    expect(called).toBe(true);
    expect(res._status).toBeUndefined();
  });

  test('429 response body shape is stable', async () => {
    const mw = createTenantTokenBucketRateLimiter({ rps: 1, burst: 1 });
    // Consume token.
    await runMiddleware(mw, makeReq('shape'), makeRes());
    const res = makeRes();
    await runMiddleware(mw, makeReq('shape'), res);
    expect(res._status).toBe(429);
    const body = res._body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['code', 'error', 'retryAfterSeconds', 'statusCode'].sort()
    );
  });
});

describe('UsageRollupConsumer rateLimited counter integration', () => {
  test('rate_limit.exceeded events accumulate into the daily rollup', async () => {
    const { InMemoryDailyDocStore, UsageRollupConsumer } = await import(
      '../services/metering/UsageRollupConsumer.js'
    );
    const { InMemoryUsageMeteringBus } = await import(
      '../services/metering/UsageMeteringBus.js'
    );

    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);
    const bus = new InMemoryUsageMeteringBus();
    consumer.attach(bus);

    let nowMs = 1_700_000_000_000;
    const mw = createTenantTokenBucketRateLimiter({
      rps: 1,
      burst: 1,
      meteringBus: bus,
      now: () => nowMs,
    });

    await runMiddleware(mw, makeReq('roll'), makeRes()); // consume
    await runMiddleware(mw, makeReq('roll'), makeRes()); // 429 + event
    nowMs += 1500;
    await runMiddleware(mw, makeReq('roll'), makeRes()); // consume refill
    await runMiddleware(mw, makeReq('roll'), makeRes()); // 429 + event
    await new Promise((r) => setTimeout(r, 10));

    const docs = store.list('roll');
    expect(docs.length).toBeGreaterThan(0);
    const total = docs.reduce((s, d) => s + d.rateLimited, 0);
    expect(total).toBe(2);
  });
});

// Silence the unused-vars lint for the test-only helper export below.
vi.fn();
