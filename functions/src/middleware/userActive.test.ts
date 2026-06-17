import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createUserActiveMiddleware } from './userActive.js';
import {
  InMemoryUserActiveDailyStore,
} from '../services/metering/UserActiveDailyStore.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../services/metering/MeteringBus.js';
import { setMeteringBus } from '../services/metering/index.js';
import {
  InMemoryUsageMeteringBus,
  type UsageMeteringEvent,
} from '../services/metering/UsageMeteringBus.js';

class CapturingSink implements MeteringSink {
  events: NormalizedMeteringEvent[] = [];
  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    path: '/api/v1/tenants/acme/usage',
    user: { uid: 'u_1' },
    tenantId: 'acme',
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response {
  return {} as unknown as Response;
}

describe('userActive middleware', () => {
  let sink: CapturingSink;
  let bus: MeteringBus;
  let usageBus: InMemoryUsageMeteringBus;
  let usageEvents: UsageMeteringEvent[];

  beforeEach(() => {
    sink = new CapturingSink();
    bus = new MeteringBus({ sink, flushIntervalMs: 5 });
    setMeteringBus(bus);
    usageBus = new InMemoryUsageMeteringBus();
    usageEvents = [];
    usageBus.subscribe((e) => {
      usageEvents.push(e);
    });
  });

  afterEach(() => {
    setMeteringBus(null);
    vi.useRealTimers();
  });

  it('emits exactly one user.active on first hit of the UTC day', async () => {
    const store = new InMemoryUserActiveDailyStore();
    const mw = createUserActiveMiddleware({ store, usageBus });

    const next = vi.fn() as NextFunction;
    await mw(makeReq(), makeRes(), next);
    await mw(makeReq(), makeRes(), next);
    await mw(makeReq(), makeRes(), next);

    await bus.flush();
    // Let microtasks settle for the fire-and-forget usage publish.
    await new Promise((r) => setTimeout(r, 0));

    expect(next).toHaveBeenCalledTimes(3);
    const userActive = sink.events.filter((e) => e.type === 'user.active');
    expect(userActive).toHaveLength(1);
    expect(userActive[0]).toMatchObject({
      type: 'user.active',
      tenantId: 'acme',
      count: 1,
      resourceId: 'u_1',
    });
    expect(userActive[0].meta).toMatchObject({
      route: '/api/v1/tenants/acme/usage',
    });
    expect(userActive[0].meta?.firstSeenAt).toEqual(expect.any(String));

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      tenantId: 'acme',
      counter: 'activeUsers',
      value: 1,
    });
  });

  it('does NOT emit for host-API-key (service-to-service) requests', async () => {
    const store = new InMemoryUserActiveDailyStore();
    const mw = createUserActiveMiddleware({ store, usageBus });

    const req = makeReq({
      user: undefined,
      tenant: { id: 'acme', scopes: ['webhooks.write'], keyId: 'k_1' },
    } as unknown as Partial<Request>);
    const next = vi.fn() as NextFunction;
    await mw(req, makeRes(), next);

    await bus.flush();
    expect(next).toHaveBeenCalledTimes(1);
    expect(sink.events.filter((e) => e.type === 'user.active')).toHaveLength(0);
    expect(usageEvents).toHaveLength(0);
  });

  it('emits separately per tenant for the same user (multi-tenant resale)', async () => {
    const store = new InMemoryUserActiveDailyStore();
    const mw = createUserActiveMiddleware({ store, usageBus });
    const next = vi.fn() as NextFunction;

    await mw(makeReq({ tenantId: 'acme' } as Partial<Request>), makeRes(), next);
    await mw(makeReq({ tenantId: 'globex' } as Partial<Request>), makeRes(), next);
    // Repeat — both already-seen, so no new emissions.
    await mw(makeReq({ tenantId: 'acme' } as Partial<Request>), makeRes(), next);
    await mw(makeReq({ tenantId: 'globex' } as Partial<Request>), makeRes(), next);

    await bus.flush();
    await new Promise((r) => setTimeout(r, 0));

    const userActive = sink.events.filter((e) => e.type === 'user.active');
    expect(userActive).toHaveLength(2);
    expect(new Set(userActive.map((e) => e.tenantId))).toEqual(
      new Set(['acme', 'globex'])
    );
    expect(usageEvents).toHaveLength(2);
  });

  it('skips silently when req.user and req.tenantId are absent', async () => {
    const store = new InMemoryUserActiveDailyStore();
    const mw = createUserActiveMiddleware({ store, usageBus });

    const req = { path: '/x' } as unknown as Request;
    const next = vi.fn() as NextFunction;
    await mw(req, makeRes(), next);

    await bus.flush();
    expect(next).toHaveBeenCalledTimes(1);
    expect(sink.events).toHaveLength(0);
  });
});
