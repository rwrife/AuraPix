import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MeteringBus,
  NoopMeteringSink,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from './MeteringBus.js';

class CapturingSink implements MeteringSink {
  batches: NormalizedMeteringEvent[][] = [];
  deliverImpl: (events: NormalizedMeteringEvent[]) => Promise<void> = async () => {};

  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    this.batches.push(events);
    await this.deliverImpl(events);
  }
}

describe('MeteringBus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('preserves emit ordering within a batch', async () => {
    const sink = new CapturingSink();
    const bus = new MeteringBus({ sink, flushIntervalMs: 1000, maxBatchSize: 50 });

    bus.emit({ tenantId: 't1', type: 'upload.accepted' });
    bus.emit({ tenantId: 't1', type: 'image.processed' });
    bus.emit({ tenantId: 't2', type: 'signed_url.issued' });

    await bus.flush();

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]!.map((e) => e.type)).toEqual([
      'upload.accepted',
      'image.processed',
      'signed_url.issued',
    ]);
    expect(sink.batches[0]!.map((e) => e.tenantId)).toEqual(['t1', 't1', 't2']);
  });

  it('defaults count to 1 and stamps occurredAt', async () => {
    const sink = new CapturingSink();
    const bus = new MeteringBus({ sink, flushIntervalMs: 1000 });

    bus.emit({ tenantId: 't1', type: 'upload.accepted' });
    await bus.flush();

    const event = sink.batches[0]![0]!;
    expect(event.count).toBe(1);
    expect(typeof event.occurredAt).toBe('string');
    expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
  });

  it('respects an explicit count and occurredAt', async () => {
    const sink = new CapturingSink();
    const bus = new MeteringBus({ sink, flushIntervalMs: 1000 });

    bus.emit({
      tenantId: 't1',
      type: 'image.processed',
      count: 5,
      occurredAt: '2025-01-01T00:00:00.000Z',
    });
    await bus.flush();

    expect(sink.batches[0]![0]).toMatchObject({
      count: 5,
      occurredAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('flushes immediately when batch threshold is reached', async () => {
    const sink = new CapturingSink();
    const bus = new MeteringBus({ sink, maxBatchSize: 3, flushIntervalMs: 60_000 });

    bus.emit({ tenantId: 't1', type: 'upload.accepted' });
    bus.emit({ tenantId: 't1', type: 'upload.accepted' });
    expect(sink.batches).toHaveLength(0);

    bus.emit({ tenantId: 't1', type: 'upload.accepted' });
    // microtask drain
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]).toHaveLength(3);
    expect(bus.pendingCount()).toBe(0);
  });

  it('flushes on the interval timer', async () => {
    const sink = new CapturingSink();
    const bus = new MeteringBus({ sink, maxBatchSize: 50, flushIntervalMs: 1000 });

    bus.emit({ tenantId: 't1', type: 'edit.applied' });
    expect(sink.batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    // Allow flush microtasks to settle.
    await Promise.resolve();

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]![0]!.type).toBe('edit.applied');
  });

  it('emit never throws even when sink rejects', async () => {
    const sink = new CapturingSink();
    sink.deliverImpl = async () => {
      throw new Error('boom');
    };
    const bus = new MeteringBus({ sink, flushIntervalMs: 10 });

    expect(() => bus.emit({ tenantId: 't1', type: 'upload.accepted' })).not.toThrow();
    await expect(bus.flush()).resolves.toBeUndefined();
  });

  it('shutdown flushes pending events', async () => {
    const sink = new CapturingSink();
    const bus = new MeteringBus({ sink, flushIntervalMs: 60_000 });

    bus.emit({ tenantId: 't1', type: 'upload.accepted' });
    await bus.shutdown();

    expect(sink.batches).toHaveLength(1);
  });

  it('NoopMeteringSink discards events silently', async () => {
    const sink = new NoopMeteringSink();
    await expect(
      sink.deliver([
        {
          tenantId: 't1',
          type: 'upload.accepted',
          count: 1,
          occurredAt: new Date().toISOString(),
        },
      ])
    ).resolves.toBeUndefined();
  });
});
