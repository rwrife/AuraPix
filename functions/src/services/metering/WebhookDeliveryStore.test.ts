import { describe, expect, it } from 'vitest';
import {
  InMemoryWebhookDeliveryStore,
  computeDeliveryExpiry,
  WEBHOOK_DELIVERY_TTL_DAYS,
  type WebhookDeliveryRecord,
} from './WebhookDeliveryStore.js';

function makeRecord(
  overrides: Partial<WebhookDeliveryRecord> = {}
): WebhookDeliveryRecord {
  const sentAt = overrides.sentAt ?? '2025-01-01T00:00:00.000Z';
  return {
    batchId: 'b1',
    tenantId: 't1',
    sentAt,
    statusCode: null,
    ok: false,
    attemptCount: 0,
    eventCount: 1,
    contentHash: 'a'.repeat(64),
    status: 'pending',
    updatedAt: sentAt,
    expiresAt: computeDeliveryExpiry(sentAt),
    ...overrides,
  };
}

describe('computeDeliveryExpiry', () => {
  it('returns sentAt + 30 days', () => {
    const sentAt = '2025-01-01T00:00:00.000Z';
    const expiry = computeDeliveryExpiry(sentAt);
    const days =
      (new Date(expiry).getTime() - new Date(sentAt).getTime()) /
      (24 * 60 * 60 * 1000);
    expect(days).toBe(WEBHOOK_DELIVERY_TTL_DAYS);
  });
});

describe('InMemoryWebhookDeliveryStore', () => {
  it('create is idempotent on batchId', async () => {
    const store = new InMemoryWebhookDeliveryStore();
    await store.create(makeRecord({ batchId: 'b1', status: 'pending' }));
    await store.create(makeRecord({ batchId: 'b1', status: 'failed' }));
    const got = await store.get('t1', 'b1');
    expect(got?.status).toBe('pending');
  });

  it('update patches existing record and returns the new one', async () => {
    const store = new InMemoryWebhookDeliveryStore();
    await store.create(makeRecord({ batchId: 'b1' }));
    const updated = await store.update('t1', 'b1', {
      status: 'ok',
      statusCode: 200,
      ok: true,
      attemptCount: 1,
    });
    expect(updated?.status).toBe('ok');
    expect(updated?.statusCode).toBe(200);
    expect(updated?.ok).toBe(true);
    const fetched = await store.get('t1', 'b1');
    expect(fetched?.status).toBe('ok');
  });

  it('update on a missing record returns null', async () => {
    const store = new InMemoryWebhookDeliveryStore();
    const updated = await store.update('t1', 'missing', { status: 'failed' });
    expect(updated).toBeNull();
  });

  it('list filters by status and orders newest first', async () => {
    const store = new InMemoryWebhookDeliveryStore();
    await store.create(makeRecord({ batchId: 'a', sentAt: '2025-01-01T00:00:00.000Z', status: 'ok' }));
    await store.create(makeRecord({ batchId: 'b', sentAt: '2025-01-02T00:00:00.000Z', status: 'failed' }));
    await store.create(makeRecord({ batchId: 'c', sentAt: '2025-01-03T00:00:00.000Z', status: 'failed' }));

    const failed = await store.list('t1', { status: 'failed' });
    expect(failed.items.map((r) => r.batchId)).toEqual(['c', 'b']);

    const all = await store.list('t1');
    expect(all.items.map((r) => r.batchId)).toEqual(['c', 'b', 'a']);
  });

  it('list filters by since and paginates with cursor', async () => {
    const store = new InMemoryWebhookDeliveryStore();
    for (let i = 0; i < 5; i++) {
      await store.create(
        makeRecord({
          batchId: `b${i}`,
          sentAt: `2025-01-0${i + 1}T00:00:00.000Z`,
        })
      );
    }
    const sincePage = await store.list('t1', {
      since: '2025-01-03T00:00:00.000Z',
      limit: 2,
    });
    expect(sincePage.items.map((r) => r.batchId)).toEqual(['b4', 'b3']);
    expect(sincePage.nextCursor).toBe('b3');

    const next = await store.list('t1', {
      since: '2025-01-03T00:00:00.000Z',
      limit: 2,
      cursor: sincePage.nextCursor,
    });
    expect(next.items.map((r) => r.batchId)).toEqual(['b2']);
    expect(next.nextCursor).toBeUndefined();
  });

  it('list scopes per tenant', async () => {
    const store = new InMemoryWebhookDeliveryStore();
    await store.create(makeRecord({ tenantId: 't1', batchId: 'b1' }));
    await store.create(makeRecord({ tenantId: 't2', batchId: 'b2' }));
    const t1 = await store.list('t1');
    const t2 = await store.list('t2');
    expect(t1.items.map((r) => r.batchId)).toEqual(['b1']);
    expect(t2.items.map((r) => r.batchId)).toEqual(['b2']);
  });
});
