import { createHmac } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HostWebhookSink,
  computeWebhookSignature,
} from './HostWebhookSink.js';
import { InMemoryWebhookDeliveryStore } from './WebhookDeliveryStore.js';
import type { NormalizedMeteringEvent } from './MeteringBus.js';

function makeEvent(
  overrides: Partial<NormalizedMeteringEvent> = {}
): NormalizedMeteringEvent {
  return {
    tenantId: 't1',
    type: 'upload.accepted',
    count: 1,
    occurredAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computeWebhookSignature', () => {
  it('produces v1=<hex(hmac_sha256)> over the body', () => {
    const sig = computeWebhookSignature('hello', 'secret');
    const expected =
      'v1=' + createHmac('sha256', 'secret').update('hello').digest('hex');
    expect(sig).toBe(expected);
    expect(sig.startsWith('v1=')).toBe(true);
    expect(sig.length).toBe('v1='.length + 64);
  });

  it('changes when body changes', () => {
    const a = computeWebhookSignature('a', 'k');
    const b = computeWebhookSignature('b', 'k');
    expect(a).not.toBe(b);
  });

  it('changes when secret changes', () => {
    const a = computeWebhookSignature('x', 'k1');
    const b = computeWebhookSignature('x', 'k2');
    expect(a).not.toBe(b);
  });
});

describe('HostWebhookSink', () => {
  it('is disabled and no-ops when webhookUrl is unset', async () => {
    const fetchImpl = vi.fn();
    const sink = new HostWebhookSink({
      signingSecret: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(sink.enabled).toBe(false);
    await sink.deliver([makeEvent()]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs JSON body with HMAC X-AuraPix-Signature header', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 'topsecret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await sink.deliver([makeEvent()]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    const body = init.body as string;
    const expected = computeWebhookSignature(body, 'topsecret');
    expect(init.headers['X-AuraPix-Signature']).toBe(expected);

    const parsed = JSON.parse(body);
    expect(parsed.version).toBe('v1');
    expect(typeof parsed.batchId).toBe('string');
    expect(parsed.batchId.length).toBeGreaterThan(0);
    expect(init.headers['X-AuraPix-Idempotency-Key']).toBe(parsed.batchId);
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].type).toBe('upload.accepted');
  });

  it('retries up to maxAttempts on non-2xx, then drops without throwing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500 } as Response);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 's',
      maxAttempts: 3,
      backoffBaseMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    await expect(sink.deliver([makeEvent()])).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Two sleeps: between attempts 1->2 and 2->3.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('retries on fetch rejection and succeeds on a later attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 's',
      maxAttempts: 3,
      backoffBaseMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    await sink.deliver([makeEvent()]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not POST an empty batch', async () => {
    const fetchImpl = vi.fn();
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sink.deliver([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('HostWebhookSink + WebhookDeliveryStore (issue #144)', () => {
  function makeEvent(
    overrides: Partial<NormalizedMeteringEvent> = {}
  ): NormalizedMeteringEvent {
    return {
      tenantId: 't1',
      type: 'upload.accepted',
      count: 1,
      occurredAt: '2025-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('writes an ok delivery record on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const store = new InMemoryWebhookDeliveryStore();
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deliveryStore: store,
      batchIdFactory: () => 'batch-1',
    });

    await sink.deliver([makeEvent()]);

    const rec = await store.get('t1', 'batch-1');
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe('ok');
    expect(rec!.ok).toBe(true);
    expect(rec!.statusCode).toBe(200);
    expect(rec!.attemptCount).toBe(1);
    expect(rec!.eventCount).toBe(1);
    expect(rec!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec!.expiresAt > rec!.sentAt).toBe(true);
  });

  it('writes a failed delivery record after exhausting retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502 } as Response);
    const store = new InMemoryWebhookDeliveryStore();
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 's',
      maxAttempts: 2,
      backoffBaseMs: 1,
      sleep: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deliveryStore: store,
      batchIdFactory: () => 'batch-2',
    });

    await sink.deliver([makeEvent()]);

    const rec = await store.get('t1', 'batch-2');
    expect(rec!.status).toBe('failed');
    expect(rec!.ok).toBe(false);
    expect(rec!.statusCode).toBe(502);
    expect(rec!.attemptCount).toBe(2);
    expect(rec!.errorMessage).toMatch(/502/);
  });

  it('replayBatch re-POSTs with the same idempotency key and updates the existing record', async () => {
    // First call fails 3x, second call (replay) succeeds.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const store = new InMemoryWebhookDeliveryStore();
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 's',
      maxAttempts: 3,
      backoffBaseMs: 1,
      sleep: vi.fn().mockResolvedValue(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deliveryStore: store,
      batchIdFactory: () => 'batch-3',
    });

    const events = [makeEvent()];
    await sink.deliver(events);
    const failed = await store.get('t1', 'batch-3');
    expect(failed!.status).toBe('failed');

    // Replay using cached events on the sink.
    const cached = sink.getCachedBatch('batch-3');
    expect(cached).toBeDefined();
    const updated = await sink.replayBatch(cached!, 'batch-3');

    expect(updated!.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // All 4 calls used the same idempotency key.
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as { headers: Record<string, string> };
      expect(init.headers['X-AuraPix-Idempotency-Key']).toBe('batch-3');
    }
    // Single record (no duplicate row).
    const all = await store.list('t1');
    expect(all.items).toHaveLength(1);
    expect(all.items[0]!.batchId).toBe('batch-3');
  });

  it('concurrent replays for the same batchId do not double-POST', async () => {
    let resolveFirst: (value: Response) => void = () => {};
    const firstPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const store = new InMemoryWebhookDeliveryStore();
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 's',
      maxAttempts: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deliveryStore: store,
      batchIdFactory: () => 'batch-4',
    });

    const events = [makeEvent()];
    const first = sink.deliver(events);
    // Second call lands while the first is still in flight.
    const second = sink.replayBatch(events, 'batch-4');
    // Release the first call.
    resolveFirst({ ok: true, status: 200 } as Response);
    await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('HostWebhookSink + per-tenant secrets (issue #161 dual-sign)', () => {
  function makeEvent(
    overrides: Partial<NormalizedMeteringEvent> = {}
  ): NormalizedMeteringEvent {
    return {
      tenantId: 't1',
      type: 'upload.accepted',
      count: 1,
      occurredAt: '2025-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('signs with the tenant secret when a resolver is configured', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 'process-wide-fallback',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secretsResolver: async (tenantId) => {
        expect(tenantId).toBe('t1');
        return {
          current: { secret: 'tenant-current-secret', fingerprint: 'fpnew0000000000a' },
        };
      },
    });

    await sink.deliver([makeEvent()]);

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = init.body as string;
    const expected = computeWebhookSignature(body, 'tenant-current-secret');
    expect(init.headers['X-AuraPix-Signature']).toBe(expected);
    // Fallback secret must NOT appear in the header at all.
    const fallback = computeWebhookSignature(body, 'process-wide-fallback');
    expect(init.headers['X-AuraPix-Signature']).not.toContain(fallback);
  });

  it('falls back to the process-wide secret when the resolver returns null', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 'process-wide-fallback',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secretsResolver: async () => null,
    });

    await sink.deliver([makeEvent()]);

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = init.body as string;
    const expected = computeWebhookSignature(body, 'process-wide-fallback');
    expect(init.headers['X-AuraPix-Signature']).toBe(expected);
  });

  it('falls back to the process-wide secret when the resolver throws', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 'process-wide-fallback',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secretsResolver: async () => {
        throw new Error('boom');
      },
    });

    await sink.deliver([makeEvent()]);
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = init.body as string;
    expect(init.headers['X-AuraPix-Signature']).toBe(
      computeWebhookSignature(body, 'process-wide-fallback')
    );
  });

  it('sends comma-separated dual signatures inside the rotation grace window', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const store = new InMemoryWebhookDeliveryStore();
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 'process-wide-fallback',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deliveryStore: store,
      batchIdFactory: () => 'batch-dual',
      secretsResolver: async () => ({
        current: { secret: 'new-secret', fingerprint: 'fpnew0000000000a' },
        previous: { secret: 'old-secret', fingerprint: 'fpold0000000000b' },
      }),
    });

    await sink.deliver([makeEvent()]);

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = init.body as string;
    const sigNew = computeWebhookSignature(body, 'new-secret');
    const sigOld = computeWebhookSignature(body, 'old-secret');
    // Stripe-style: `v1=<new>,v1=<old>` (new first, old second).
    expect(init.headers['X-AuraPix-Signature']).toBe(`${sigNew},${sigOld}`);

    const rec = await store.get('t1', 'batch-dual');
    expect(rec!.signedFingerprints).toEqual([
      'fpnew0000000000a',
      'fpold0000000000b',
    ]);
  });

  it('drops back to single-signature after the previous secret is purged', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const store = new InMemoryWebhookDeliveryStore();
    let activePreviousSecret: { secret: string; fingerprint: string } | null = {
      secret: 'old-secret',
      fingerprint: 'fpold0000000000b',
    };
    const sink = new HostWebhookSink({
      webhookUrl: 'https://example.com/hook',
      signingSecret: 'process-wide-fallback',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deliveryStore: store,
      batchIdFactory: () => `batch-${fetchImpl.mock.calls.length + 1}`,
      secretsResolver: async () => ({
        current: { secret: 'new-secret', fingerprint: 'fpnew0000000000a' },
        ...(activePreviousSecret ? { previous: activePreviousSecret } : {}),
      }),
    });

    // First delivery: inside grace window -> two signatures.
    await sink.deliver([makeEvent()]);
    const firstSig = (fetchImpl.mock.calls[0]![1] as { headers: Record<string, string> })
      .headers['X-AuraPix-Signature'];
    expect(firstSig.split(',').length).toBe(2);

    // Simulate the purge job removing the previous secret.
    activePreviousSecret = null;

    await sink.deliver([makeEvent()]);
    const secondSig = (fetchImpl.mock.calls[1]![1] as { headers: Record<string, string> })
      .headers['X-AuraPix-Signature'];
    expect(secondSig.split(',').length).toBe(1);
    // Verify it's the new-secret signature only.
    const body2 = (fetchImpl.mock.calls[1]![1] as { body: string }).body;
    expect(secondSig).toBe(computeWebhookSignature(body2, 'new-secret'));
  });
});
