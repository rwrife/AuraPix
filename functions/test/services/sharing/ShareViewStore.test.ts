/**
 * Tests for the share-view store + tracker (issue #198).
 *
 * Covers:
 *   - 60-second de-dup window per (linkId, ipHash, uaHash)
 *   - 90-day retention on raw view rows
 *   - Aggregate counters (totalViews / uniqueViewers / bytesServed /
 *     lastViewedAt) update on new views and NOT on deduped hits
 *   - HMAC per-tenant isolation: same raw IP under two tenants \u2192
 *     different hashes
 *   - Tracker emits `share.viewed` exactly once per accepted view (not
 *     per dedup hit) and forwards bytes + referrerHost
 *   - Tracker publishes `shareEgressBytes` onto the usage bus only when
 *     bytesServed > 0
 *   - Tracker never throws; store errors are swallowed
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  InMemoryShareViewStore,
  SHARE_VIEW_DEDUP_WINDOW_MS,
  SHARE_VIEW_RETENTION_MS,
  type ShareViewStore,
  type RecordViewInput,
} from '../../../src/services/sharing/ShareViewStore.js';
import {
  ShareViewTracker,
  parseReferrerHost,
} from '../../../src/services/sharing/ShareViewTracker.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../../../src/services/metering/MeteringBus.js';
import { setMeteringBus } from '../../../src/services/metering/index.js';
import type { UsageMeteringBus } from '../../../src/services/metering/UsageMeteringBus.js';

// Capturing sink shaped like the one the existing ImageAuthorizer
// metering test uses: `deliver()` receives *normalized* events after the
// MeteringBus has batched + validated them.
class CapturingSink implements MeteringSink {
  events: NormalizedMeteringEvent[] = [];
  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    this.events.push(...events);
  }
  ofType(type: string): NormalizedMeteringEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

describe('InMemoryShareViewStore', () => {
  const tenantId = 'tenant-A';
  const linkId = 'link-1';
  let store: InMemoryShareViewStore;

  beforeEach(() => {
    store = new InMemoryShareViewStore();
  });

  function view(over: Partial<RecordViewInput> = {}): RecordViewInput {
    return {
      linkId,
      tenantId,
      viewedAt: new Date('2026-04-01T12:00:00.000Z').toISOString(),
      ipHash: 'ip-1',
      uaHash: 'ua-1',
      referrerHost: 'example.com',
      bytesServed: 100,
      ...over,
    };
  }

  it('records a first view and updates the aggregate', async () => {
    const result = await store.recordView(view());
    expect(result.recorded).toBe(true);
    expect(result.aggregate.totalViews).toBe(1);
    expect(result.aggregate.uniqueViewers).toBe(1);
    expect(result.aggregate.bytesServed).toBe(100);
    expect(result.aggregate.lastViewedAt).toBe('2026-04-01T12:00:00.000Z');
  });

  it('dedups within the 60s window for the same (ipHash, uaHash)', async () => {
    await store.recordView(view());
    const dedup = await store.recordView(
      view({
        viewedAt: new Date('2026-04-01T12:00:30.000Z').toISOString(),
        bytesServed: 500,
      })
    );
    expect(dedup.recorded).toBe(false);
    // Aggregate MUST NOT move on a dedup hit.
    expect(dedup.aggregate.totalViews).toBe(1);
    expect(dedup.aggregate.bytesServed).toBe(100);
  });

  it('does not dedup once past the 60s window', async () => {
    await store.recordView(view());
    const next = await store.recordView(
      view({
        viewedAt: new Date(
          Date.parse('2026-04-01T12:00:00.000Z') + SHARE_VIEW_DEDUP_WINDOW_MS + 1
        ).toISOString(),
      })
    );
    expect(next.recorded).toBe(true);
    expect(next.aggregate.totalViews).toBe(2);
    // Same (ip, ua) => still one unique viewer.
    expect(next.aggregate.uniqueViewers).toBe(1);
    expect(next.aggregate.bytesServed).toBe(200);
  });

  it('does not dedup for a different (ipHash, uaHash) inside the window', async () => {
    await store.recordView(view());
    const other = await store.recordView(
      view({
        viewedAt: new Date('2026-04-01T12:00:10.000Z').toISOString(),
        ipHash: 'ip-2',
        uaHash: 'ua-1',
      })
    );
    expect(other.recorded).toBe(true);
    expect(other.aggregate.totalViews).toBe(2);
    expect(other.aggregate.uniqueViewers).toBe(2);
  });

  it('exposes recent rows via listViews and drops rows older than retention', async () => {
    // Insert a fresh view.
    await store.recordView(view());
    // Insert an "ancient" row past the retention window, then verify it is
    // dropped when we ask for it.
    const oldTs = new Date(
      Date.parse('2026-04-01T12:00:00.000Z') - SHARE_VIEW_RETENTION_MS - 10_000
    ).toISOString();
    await store.recordView(view({ viewedAt: oldTs, ipHash: 'ip-old' }));

    const rows = await store.listViews(
      tenantId,
      linkId,
      new Date(0).toISOString(),
      new Date('2026-04-02T00:00:00.000Z').toISOString()
    );
    // Only the fresh row survives \u2014 the ancient one was pruned.
    expect(rows.every((r) => r.ipHash === 'ip-1')).toBe(true);
  });

  it('returns null aggregate when a link has no views', async () => {
    const agg = await store.getAggregate(tenantId, 'never-viewed');
    expect(agg).toBeNull();
  });

  it('tenant-scopes aggregates \u2014 same linkId on two tenants is disjoint', async () => {
    await store.recordView(view({ tenantId: 'tenant-A' }));
    await store.recordView(view({ tenantId: 'tenant-B', bytesServed: 999 }));
    const a = await store.getAggregate('tenant-A', linkId);
    const b = await store.getAggregate('tenant-B', linkId);
    expect(a?.bytesServed).toBe(100);
    expect(b?.bytesServed).toBe(999);
  });
});

describe('parseReferrerHost', () => {
  it('extracts the host from a full URL', () => {
    expect(parseReferrerHost('https://client.example.com/gallery?id=42')).toBe(
      'client.example.com'
    );
    expect(parseReferrerHost('http://localhost:3000/x')).toBe('localhost:3000');
  });

  it('returns null for missing / unparseable values', () => {
    expect(parseReferrerHost(null)).toBeNull();
    expect(parseReferrerHost('')).toBeNull();
    expect(parseReferrerHost('not-a-url')).toBeNull();
    expect(parseReferrerHost('data:text/plain,hello')).toBeNull();
  });
});

describe('ShareViewTracker', () => {
  const tenantId = 'tenant-A';
  const linkId = 'link-1';
  let store: InMemoryShareViewStore;
  let sink: CapturingSink;
  let bus: MeteringBus;
  let publishSpy: ReturnType<typeof vi.fn>;
  let usageBus: UsageMeteringBus;
  let tracker: ShareViewTracker;

  beforeEach(() => {
    store = new InMemoryShareViewStore();
    sink = new CapturingSink();
    // flushIntervalMs=10 + maxBatchSize=1 forces immediate flush per event.
    bus = new MeteringBus({ sink, flushIntervalMs: 10, maxBatchSize: 1 });
    setMeteringBus(bus);
    publishSpy = vi.fn().mockResolvedValue(undefined);
    usageBus = { publish: publishSpy } as unknown as UsageMeteringBus;
    tracker = new ShareViewTracker({
      store,
      hashSecret: '00'.repeat(32),
      usageBus,
    });
  });

  afterEach(async () => {
    // Drain the bus so background flush timers don't leak into the next test.
    await bus.flush().catch(() => {});
    setMeteringBus(null);
  });

  /**
   * Wait for the metering bus to flush at least `n` events of `type`
   * into the sink. The bus dispatches asynchronously so tests need a
   * small settle window before assertions.
   */
  async function waitForEvents(type: string, n: number): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      await bus.flush().catch(() => {});
      if (sink.ofType(type).length >= n) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('hashes IP + UA differently per tenant (isolation)', () => {
    const ip = '203.0.113.10';
    const a = tracker.hash('tenant-A', ip);
    const b = tracker.hash('tenant-B', ip);
    expect(a).not.toBe(b);
    // But the same tenant + same ip is stable across calls.
    expect(tracker.hash('tenant-A', ip)).toBe(a);
  });

  it('emits `share.viewed` on first record and publishes shareEgressBytes', async () => {
    const result = await tracker.record({
      tenantId,
      linkId,
      ip: '203.0.113.10',
      userAgent: 'Mozilla/5.0',
      referrer: 'https://client.example.com/gallery',
      bytesServed: 1234,
    });
    expect(result?.recorded).toBe(true);

    await waitForEvents('share.viewed', 1);
    const emitted = sink.ofType('share.viewed');
    expect(emitted.length).toBe(1);
    const evt = emitted[0]!;
    expect(evt.resourceId).toBe(linkId);
    expect(evt.count).toBe(1);
    expect(evt.bytes).toBe(1234);
    expect(evt.meta?.bytesServed).toBe(1234);
    expect(evt.meta?.referrerHost).toBe('client.example.com');

    // Async publish is fire-and-forget; wait a microtask so the .catch()
    // path settles before we assert.
    await new Promise((r) => setImmediate(r));
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const call = publishSpy.mock.calls[0]![0];
    expect(call.counter).toBe('shareEgressBytes');
    expect(call.value).toBe(1234);
    expect(call.tenantId).toBe(tenantId);
    expect(call.meta?.linkId).toBe(linkId);
  });

  it('does not emit anything on a dedup hit within the 60s window', async () => {
    const now = new Date('2026-04-01T12:00:00.000Z');
    const t = new ShareViewTracker({
      store,
      hashSecret: '00'.repeat(32),
      usageBus,
      now: () => now,
    });
    const first = await t.record({
      tenantId,
      linkId,
      ip: '203.0.113.10',
      userAgent: 'Mozilla/5.0',
      referrer: null,
      bytesServed: 100,
    });
    const second = await t.record({
      tenantId,
      linkId,
      ip: '203.0.113.10',
      userAgent: 'Mozilla/5.0',
      referrer: null,
      bytesServed: 200,
    });
    expect(first?.recorded).toBe(true);
    expect(second?.recorded).toBe(false);
    // Exactly one `share.viewed` event even though we called record twice.
    await waitForEvents('share.viewed', 1);
    // Give the bus one more tick to prove no *extra* event lands.
    await new Promise((r) => setTimeout(r, 30));
    expect(sink.ofType('share.viewed').length).toBe(1);
    await new Promise((r) => setImmediate(r));
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('does not publish shareEgressBytes when bytesServed is null or zero', async () => {
    await tracker.record({
      tenantId,
      linkId,
      ip: '203.0.113.10',
      userAgent: 'ua',
      referrer: null,
      bytesServed: null,
    });
    await tracker.record({
      tenantId,
      linkId: 'link-2',
      ip: '203.0.113.10',
      userAgent: 'ua',
      referrer: null,
      bytesServed: 0,
    });
    await new Promise((r) => setImmediate(r));
    expect(publishSpy).not.toHaveBeenCalled();
    // But `share.viewed` events STILL fire \u2014 they're the billable
    // canonical event; bytesServed is just an optional attribute.
    await waitForEvents('share.viewed', 2);
    expect(sink.ofType('share.viewed').length).toBe(2);
  });

  it('never throws \u2014 store failures are swallowed', async () => {
    const badStore: ShareViewStore = {
      recordView: () => Promise.reject(new Error('boom')),
      getAggregate: () => Promise.resolve(null),
      listViews: () => Promise.resolve([]),
    };
    const t = new ShareViewTracker({
      store: badStore,
      hashSecret: '00'.repeat(32),
      usageBus,
    });
    // Must resolve, not throw.
    const result = await t.record({
      tenantId,
      linkId,
      ip: '203.0.113.10',
      userAgent: 'ua',
      referrer: null,
      bytesServed: 10,
    });
    expect(result).toBeNull();
    // No event ever reaches the bus.
    await new Promise((r) => setTimeout(r, 30));
    expect(sink.ofType('share.viewed').length).toBe(0);
  });
});
