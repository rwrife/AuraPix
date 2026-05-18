import { describe, expect, it } from 'vitest';
import {
  InMemoryDailyDocStore,
  UsageRollupConsumer,
  isoDateUtc,
} from '../../src/services/metering/UsageRollupConsumer.js';
import {
  InMemoryUsageMeteringBus,
  type UsageMeteringEvent,
} from '../../src/services/metering/UsageMeteringBus.js';

const tenantId = 'tenant-A';

describe('UsageRollupConsumer', () => {
  it('increments deltas across multiple counters', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);

    const events: UsageMeteringEvent[] = [
      { tenantId, counter: 'imagesUploaded', value: 3, occurredAt: '2026-04-01T12:00:00Z' },
      { tenantId, counter: 'imagesUploaded', value: 2, occurredAt: '2026-04-01T13:00:00Z' },
      { tenantId, counter: 'storageBytesDelta', value: 1024, occurredAt: '2026-04-01T13:30:00Z' },
      { tenantId, counter: 'apiCalls', value: 7, occurredAt: '2026-04-01T14:00:00Z' },
    ];
    for (const e of events) {
      await consumer.apply(e);
    }

    const doc = store.get(tenantId, '2026-04-01');
    expect(doc).not.toBeNull();
    expect(doc!.imagesUploaded).toBe(5);
    expect(doc!.storageBytesDelta).toBe(1024);
    expect(doc!.apiCalls).toBe(7);
    expect(doc!.editsApplied).toBe(0);
  });

  it('partitions events by UTC day', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);

    await consumer.apply({ tenantId, counter: 'apiCalls', value: 1, occurredAt: '2026-04-01T23:59:59Z' });
    await consumer.apply({ tenantId, counter: 'apiCalls', value: 1, occurredAt: '2026-04-02T00:00:01Z' });

    expect(store.get(tenantId, '2026-04-01')!.apiCalls).toBe(1);
    expect(store.get(tenantId, '2026-04-02')!.apiCalls).toBe(1);
  });

  it('handles concurrent increments atomically', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);

    const concurrent = 50;
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < concurrent; i++) {
      work.push(
        consumer.apply({
          tenantId,
          counter: 'imagesProcessed',
          value: 1,
          occurredAt: '2026-04-03T10:00:00Z',
        })
      );
    }
    await Promise.all(work);

    expect(store.get(tenantId, '2026-04-03')!.imagesProcessed).toBe(concurrent);
  });

  it('is idempotent when eventId is reused', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);

    const event: UsageMeteringEvent = {
      tenantId,
      counter: 'editsApplied',
      value: 4,
      occurredAt: '2026-04-04T10:00:00Z',
      eventId: 'evt-1',
    };
    await consumer.apply(event);
    await consumer.apply(event);
    await consumer.apply(event);

    expect(store.get(tenantId, '2026-04-04')!.editsApplied).toBe(4);
  });

  it('keeps tenants isolated', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);

    await consumer.apply({ tenantId: 'tA', counter: 'apiCalls', value: 5, occurredAt: '2026-04-05T00:00:00Z' });
    await consumer.apply({ tenantId: 'tB', counter: 'apiCalls', value: 9, occurredAt: '2026-04-05T00:00:00Z' });

    expect(store.get('tA', '2026-04-05')!.apiCalls).toBe(5);
    expect(store.get('tB', '2026-04-05')!.apiCalls).toBe(9);
  });

  it('rejects unknown counters and bad values', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);

    await expect(
      consumer.apply({ tenantId, counter: 'bogus' as never, value: 1 })
    ).rejects.toThrow();
    await expect(
      consumer.apply({ tenantId, counter: 'apiCalls', value: Number.NaN })
    ).rejects.toThrow();
    await expect(
      consumer.apply({ tenantId: '', counter: 'apiCalls', value: 1 })
    ).rejects.toThrow();
  });

  it('subscribes to a MeteringBus', async () => {
    const store = new InMemoryDailyDocStore();
    const consumer = new UsageRollupConsumer(store);
    const bus = new InMemoryUsageMeteringBus();
    consumer.attach(bus);

    await bus.publish({
      tenantId,
      counter: 'signedUrlsIssued',
      value: 11,
      occurredAt: '2026-04-06T00:00:00Z',
    });

    expect(store.get(tenantId, '2026-04-06')!.signedUrlsIssued).toBe(11);
  });
});

describe('isoDateUtc', () => {
  it('formats arbitrary dates to YYYY-MM-DD in UTC', () => {
    expect(isoDateUtc('2026-04-01T23:59:59Z')).toBe('2026-04-01');
    expect(isoDateUtc(new Date('2026-12-31T12:00:00Z'))).toBe('2026-12-31');
  });
  it('throws on invalid input', () => {
    expect(() => isoDateUtc('not-a-date')).toThrow();
  });
});
