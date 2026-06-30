/**
 * Unit tests for the per-tenant storage threshold evaluator (issue #196).
 *
 * Covers:
 *   - First crossing emits `tenant.storage.threshold_crossed` once.
 *   - No double-fire on subsequent evaluations while still crossed.
 *   - Clearing (with 5% hysteresis) emits `tenant.storage.threshold_cleared`.
 *   - Re-crossing after clear emits `_crossed` again.
 *   - Default thresholds apply when no per-tenant override is set.
 *   - Custom thresholds override defaults.
 *   - quotaBytes null / 0 short-circuits silently.
 *   - State is persisted across calls (so re-init doesn't re-fire).
 *
 * Note: AuraPix already has a number of pre-existing TS warnings in
 * test files (vi.fn() generic vs DataAdapter index signature). We keep
 * a tiny private adapter helper here that uses `any`-style typing only
 * inside the test scope, never in production code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../metering/MeteringBus.js';
import { setMeteringBus } from '../metering/index.js';
import {
  computeTransitions,
  evaluateStorageThresholds,
  resolveThresholds,
} from './storageThresholdEvaluator.js';
import {
  DEFAULT_STORAGE_THRESHOLDS,
  STORAGE_THRESHOLD_HYSTERESIS,
  TENANTS_COLLECTION,
  thresholdStateKey,
  type TenantRecord,
} from '../../models/TenantRecord.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';

class CapturingSink implements MeteringSink {
  events: NormalizedMeteringEvent[] = [];
  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

function makeAdapter(seed: Record<string, unknown> = {}): DataAdapter {
  const docs = new Map<string, unknown>(Object.entries(seed));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter: any = {
    storeData: vi.fn(async (collection: string, id: string, data: unknown) => {
      docs.set(`${collection}::${id}`, data);
    }),
    fetchData: vi.fn(async (collection: string, id: string) => {
      return docs.get(`${collection}::${id}`) ?? null;
    }),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(),
    deleteData: vi.fn(),
    exists: vi.fn(async () => false),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => null),
  };
  // Expose the docs map for assertions.
  adapter.__docs = docs;
  return adapter as DataAdapter;
}

function makeRecord(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: 't1',
    quotaBytes: 1000,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('storageThresholdEvaluator', () => {
  let sink: CapturingSink;

  beforeEach(() => {
    sink = new CapturingSink();
    setMeteringBus(
      new MeteringBus({ sink, flushIntervalMs: 1000, maxBatchSize: 100 })
    );
  });

  afterEach(() => {
    setMeteringBus(null);
    vi.restoreAllMocks();
  });

  describe('resolveThresholds()', () => {
    it('returns defaults when no override is set', () => {
      expect(resolveThresholds(makeRecord())).toEqual([
        ...DEFAULT_STORAGE_THRESHOLDS,
      ]);
    });

    it('returns defaults when override is empty', () => {
      expect(
        resolveThresholds(makeRecord({ storageThresholds: [] }))
      ).toEqual([...DEFAULT_STORAGE_THRESHOLDS]);
    });

    it('uses tenant override when present, sorted and deduped', () => {
      expect(
        resolveThresholds(
          makeRecord({ storageThresholds: [0.9, 0.5, 0.9001, 1.2] })
        )
      ).toEqual([0.5, 0.9, 1.2]);
    });
  });

  describe('computeTransitions()', () => {
    const now = new Date('2026-06-30T12:00:00.000Z');

    it('first crossing emits one crossed transition', () => {
      const { nextState, transitions } = computeTransitions({
        thresholds: [0.5, 0.8, 0.95, 1.0],
        usedBytes: 850,
        quotaBytes: 1000,
        previousState: {},
        now,
      });
      expect(transitions).toEqual([
        { threshold: 0.5, direction: 'crossed' },
        { threshold: 0.8, direction: 'crossed' },
      ]);
      expect(nextState[thresholdStateKey(0.5)]?.crossed).toBe(true);
      expect(nextState[thresholdStateKey(0.8)]?.crossed).toBe(true);
      expect(nextState[thresholdStateKey(0.95)]?.crossed).toBe(false);
    });

    it('does not double-fire while still in the crossed band', () => {
      const prior = {
        [thresholdStateKey(0.8)]: {
          crossed: true,
          lastCrossedAt: '2026-06-29T00:00:00.000Z',
        },
      };
      const { transitions } = computeTransitions({
        thresholds: [0.8],
        usedBytes: 900,
        quotaBytes: 1000,
        previousState: prior,
        now,
      });
      expect(transitions).toEqual([]);
    });

    it('clears only after hysteresis band is satisfied', () => {
      const prior = {
        [thresholdStateKey(0.8)]: {
          crossed: true,
          lastCrossedAt: '2026-06-29T00:00:00.000Z',
        },
      };
      // 0.8 - 0.05 = 0.75 \u2192 760 / 1000 = 0.76 should NOT clear yet.
      const stillHigh = computeTransitions({
        thresholds: [0.8],
        usedBytes: 760,
        quotaBytes: 1000,
        previousState: prior,
        now,
      });
      expect(stillHigh.transitions).toEqual([]);

      // 750 / 1000 = 0.75 == 0.8 - 0.05 \u2192 boundary should clear.
      const justClears = computeTransitions({
        thresholds: [0.8],
        usedBytes: 750,
        quotaBytes: 1000,
        previousState: prior,
        now,
      });
      expect(justClears.transitions).toEqual([
        { threshold: 0.8, direction: 'cleared' },
      ]);
      expect(justClears.nextState[thresholdStateKey(0.8)]?.crossed).toBe(false);
    });

    it('re-crosses after a clear emits crossed again', () => {
      // Phase 1: cross.
      const phase1 = computeTransitions({
        thresholds: [0.8],
        usedBytes: 850,
        quotaBytes: 1000,
        previousState: {},
        now,
      });
      expect(phase1.transitions).toEqual([
        { threshold: 0.8, direction: 'crossed' },
      ]);

      // Phase 2: clear (drop well below hysteresis band).
      const phase2 = computeTransitions({
        thresholds: [0.8],
        usedBytes: 700,
        quotaBytes: 1000,
        previousState: phase1.nextState,
        now,
      });
      expect(phase2.transitions).toEqual([
        { threshold: 0.8, direction: 'cleared' },
      ]);

      // Phase 3: re-cross.
      const phase3 = computeTransitions({
        thresholds: [0.8],
        usedBytes: 850,
        quotaBytes: 1000,
        previousState: phase2.nextState,
        now,
      });
      expect(phase3.transitions).toEqual([
        { threshold: 0.8, direction: 'crossed' },
      ]);
    });

    it('short-circuits when quotaBytes <= 0', () => {
      const result = computeTransitions({
        thresholds: [0.5],
        usedBytes: 1000,
        quotaBytes: 0,
        previousState: {},
        now,
      });
      expect(result.transitions).toEqual([]);
    });

    it('preserves observability fields on no-change ticks', () => {
      const prior = {
        [thresholdStateKey(0.8)]: {
          crossed: true,
          lastCrossedAt: '2026-06-29T00:00:00.000Z',
        },
      };
      const { nextState } = computeTransitions({
        thresholds: [0.8],
        usedBytes: 900,
        quotaBytes: 1000,
        previousState: prior,
        now,
      });
      expect(nextState[thresholdStateKey(0.8)]?.lastCrossedAt).toBe(
        '2026-06-29T00:00:00.000Z'
      );
    });

    it('honors the documented hysteresis constant', () => {
      // Guard against accidental changes to the constant value.
      expect(STORAGE_THRESHOLD_HYSTERESIS).toBeCloseTo(0.05);
    });
  });

  describe('evaluateStorageThresholds() integration', () => {
    it('emits the crossed event and persists state', async () => {
      const adapter = makeAdapter({
        [`${TENANTS_COLLECTION}::t1`]: makeRecord({ quotaBytes: 1000 }),
      });
      const bus = new MeteringBus({
        sink,
        flushIntervalMs: 1000,
        maxBatchSize: 100,
      });
      setMeteringBus(bus);

      const { transitions } = await evaluateStorageThresholds({
        dataAdapter: adapter,
        tenantId: 't1',
        usedBytes: 850,
        now: () => new Date('2026-06-30T12:00:00.000Z'),
      });
      await bus.flush();

      expect(transitions.map((t) => t.direction)).toEqual([
        'crossed',
        'crossed',
      ]);
      expect(sink.events).toHaveLength(2);
      expect(sink.events[0]!.type).toBe('tenant.storage.threshold_crossed');
      expect(sink.events[0]!.meta).toMatchObject({
        tenantId: 't1',
        usedBytes: 850,
        quotaBytes: 1000,
        crossedAt: '2026-06-30T12:00:00.000Z',
      });

      // Persisted state should now have both crossed=true.
      const persisted = await adapter.fetchData<TenantRecord>(
        TENANTS_COLLECTION,
        't1'
      );
      expect(persisted?.storageThresholdState?.[thresholdStateKey(0.5)]?.crossed).toBe(
        true
      );
      expect(persisted?.storageThresholdState?.[thresholdStateKey(0.8)]?.crossed).toBe(
        true
      );
    });

    it('does not re-fire on a second evaluation at the same usage', async () => {
      const adapter = makeAdapter({
        [`${TENANTS_COLLECTION}::t1`]: makeRecord({ quotaBytes: 1000 }),
      });
      const bus = new MeteringBus({
        sink,
        flushIntervalMs: 1000,
        maxBatchSize: 100,
      });
      setMeteringBus(bus);

      await evaluateStorageThresholds({
        dataAdapter: adapter,
        tenantId: 't1',
        usedBytes: 850,
        now: () => new Date('2026-06-30T12:00:00.000Z'),
      });
      await evaluateStorageThresholds({
        dataAdapter: adapter,
        tenantId: 't1',
        usedBytes: 860,
        now: () => new Date('2026-06-30T12:01:00.000Z'),
      });
      await bus.flush();

      // Only first call should have emitted.
      expect(sink.events.filter((e) => e.type === 'tenant.storage.threshold_crossed'))
        .toHaveLength(2); // 0.5 + 0.8 from first call only
    });

    it('emits cleared after usage drops below hysteresis band', async () => {
      const adapter = makeAdapter({
        [`${TENANTS_COLLECTION}::t1`]: makeRecord({ quotaBytes: 1000 }),
      });
      const bus = new MeteringBus({
        sink,
        flushIntervalMs: 1000,
        maxBatchSize: 100,
      });
      setMeteringBus(bus);

      await evaluateStorageThresholds({
        dataAdapter: adapter,
        tenantId: 't1',
        usedBytes: 850,
        now: () => new Date('2026-06-30T12:00:00.000Z'),
      });
      // Drop to 700/1000 = 0.70; 0.8 threshold - 0.05 = 0.75; cleared.
      // 0.5 threshold - 0.05 = 0.45; 0.70 > 0.45 so 0.5 stays crossed.
      await evaluateStorageThresholds({
        dataAdapter: adapter,
        tenantId: 't1',
        usedBytes: 700,
        now: () => new Date('2026-06-30T13:00:00.000Z'),
      });
      await bus.flush();

      const clearedEvents = sink.events.filter(
        (e) => e.type === 'tenant.storage.threshold_cleared'
      );
      expect(clearedEvents).toHaveLength(1);
      expect(clearedEvents[0]!.meta).toMatchObject({
        threshold: 0.8,
        usedBytes: 700,
      });
    });

    it('uses custom thresholds when set on the tenant doc', async () => {
      const adapter = makeAdapter({
        [`${TENANTS_COLLECTION}::t1`]: makeRecord({
          quotaBytes: 1000,
          storageThresholds: [0.25, 0.75],
        }),
      });
      const bus = new MeteringBus({
        sink,
        flushIntervalMs: 1000,
        maxBatchSize: 100,
      });
      setMeteringBus(bus);

      await evaluateStorageThresholds({
        dataAdapter: adapter,
        tenantId: 't1',
        usedBytes: 300,
        now: () => new Date('2026-06-30T12:00:00.000Z'),
      });
      await bus.flush();

      // 0.25 crossed (300/1000 = 0.30), 0.75 not.
      const crossed = sink.events.filter(
        (e) => e.type === 'tenant.storage.threshold_crossed'
      );
      expect(crossed).toHaveLength(1);
      expect(crossed[0]!.meta).toMatchObject({ threshold: 0.25 });
    });

    it('uses default thresholds when no override is set', async () => {
      const adapter = makeAdapter({
        [`${TENANTS_COLLECTION}::t1`]: makeRecord({
          quotaBytes: 1000,
          // no storageThresholds
        }),
      });
      const bus = new MeteringBus({
        sink,
        flushIntervalMs: 1000,
        maxBatchSize: 100,
      });
      setMeteringBus(bus);

      // 510 / 1000 = 0.51 \u2192 should cross 0.5 (default), not 0.8.
      await evaluateStorageThresholds({
        dataAdapter: adapter,
        tenantId: 't1',
        usedBytes: 510,
        now: () => new Date('2026-06-30T12:00:00.000Z'),
      });
      await bus.flush();

      const crossed = sink.events.filter(
        (e) => e.type === 'tenant.storage.threshold_crossed'
      );
      expect(crossed).toHaveLength(1);
      expect(crossed[0]!.meta).toMatchObject({ threshold: 0.5 });
    });

    it('short-circuits when quotaBytes is null (unlimited)', async () => {
      const adapter = makeAdapter({
        [`${TENANTS_COLLECTION}::t1`]: makeRecord({ quotaBytes: null }),
      });
      const bus = new MeteringBus({
        sink,
        flushIntervalMs: 1000,
        maxBatchSize: 100,
      });
      setMeteringBus(bus);

      const result = await evaluateStorageThresholds({
        dataAdapter: adapter,
        tenantId: 't1',
        usedBytes: 10_000_000,
        now: () => new Date('2026-06-30T12:00:00.000Z'),
      });
      await bus.flush();

      expect(result.transitions).toEqual([]);
      expect(sink.events).toHaveLength(0);
    });

    it('short-circuits when quotaBytes is 0 (uploads blocked)', async () => {
      const adapter = makeAdapter({
        [`${TENANTS_COLLECTION}::t1`]: makeRecord({ quotaBytes: 0 }),
      });
      const bus = new MeteringBus({
        sink,
        flushIntervalMs: 1000,
        maxBatchSize: 100,
      });
      setMeteringBus(bus);

      const result = await evaluateStorageThresholds({
        dataAdapter: adapter,
        tenantId: 't1',
        usedBytes: 0,
        now: () => new Date('2026-06-30T12:00:00.000Z'),
      });
      await bus.flush();

      expect(result.transitions).toEqual([]);
      expect(sink.events).toHaveLength(0);
    });

    it('swallows fetch errors and returns no transitions', async () => {
      const adapter = makeAdapter();
      // Force fetchData to throw.
      (adapter.fetchData as unknown as { mockImplementation: Function }).mockImplementation(
        async () => {
          throw new Error('boom');
        }
      );

      const result = await evaluateStorageThresholds({
        dataAdapter: adapter,
        tenantId: 't1',
        usedBytes: 850,
        now: () => new Date('2026-06-30T12:00:00.000Z'),
      });

      expect(result.transitions).toEqual([]);
    });
  });
});
