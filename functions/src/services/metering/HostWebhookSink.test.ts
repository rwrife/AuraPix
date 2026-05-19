import { createHmac } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HostWebhookSink,
  computeWebhookSignature,
} from './HostWebhookSink.js';
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
