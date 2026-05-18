import { createHmac } from 'crypto';
import { logger } from '../../utils/logger.js';
import type {
  MeteringSink,
  NormalizedMeteringEvent,
} from './MeteringBus.js';

export interface HostWebhookSinkOptions {
  /** Endpoint to POST batched events. If unset, sink is a no-op. */
  webhookUrl?: string;
  /** Secret used for HMAC-SHA256 of the request body. */
  signingSecret: string;
  /** Request timeout per attempt (ms). Default 5000. */
  timeoutMs?: number;
  /** Maximum delivery attempts (initial + retries). Default 3. */
  maxAttempts?: number;
  /** Base backoff delay (ms). Default 200. */
  backoffBaseMs?: number;
  /** Inject custom fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Inject sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const SIGNATURE_HEADER = 'X-AuraPix-Signature';
const SIGNATURE_VERSION = 'v1';

/**
 * Compute the value of the `X-AuraPix-Signature` header for a request body.
 *
 * Format: `v1=<hex(hmac_sha256(secret, body))>`
 */
export function computeWebhookSignature(
  body: string,
  signingSecret: string
): string {
  const mac = createHmac('sha256', signingSecret).update(body).digest('hex');
  return `${SIGNATURE_VERSION}=${mac}`;
}

/**
 * Sink that POSTs batched metering events to a host-supplied webhook URL.
 *
 * - HMAC-SHA256 signature in `X-AuraPix-Signature` header.
 * - Retries up to `maxAttempts` with exponential backoff.
 * - Drops the batch on exhaustion and logs; never throws.
 * - When `webhookUrl` is unset, behaves as a no-op.
 */
export class HostWebhookSink implements MeteringSink {
  private readonly webhookUrl?: string;
  private readonly signingSecret: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: HostWebhookSinkOptions) {
    this.webhookUrl = opts.webhookUrl;
    this.signingSecret = opts.signingSecret;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 200;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** True when a webhook URL is configured. */
  get enabled(): boolean {
    return Boolean(this.webhookUrl);
  }

  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    if (!this.webhookUrl || events.length === 0) {
      return;
    }

    const body = JSON.stringify({
      version: SIGNATURE_VERSION,
      sentAt: new Date().toISOString(),
      events,
    });
    const signature = computeWebhookSignature(body, this.signingSecret);

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SIGNATURE_HEADER]: signature,
          },
          body,
          signal: controller.signal,
        });
        if (response.ok) {
          return;
        }
        lastError = new Error(
          `Webhook returned non-2xx status ${response.status}`
        );
        logger.warn(
          {
            attempt,
            status: response.status,
            webhookUrl: this.webhookUrl,
            eventCount: events.length,
          },
          'Metering webhook returned non-2xx; will retry if attempts remain'
        );
      } catch (err) {
        lastError = err;
        logger.warn(
          {
            attempt,
            err,
            webhookUrl: this.webhookUrl,
            eventCount: events.length,
          },
          'Metering webhook delivery failed; will retry if attempts remain'
        );
      } finally {
        clearTimeout(timeout);
      }

      if (attempt < this.maxAttempts) {
        const delay = this.backoffBaseMs * 2 ** (attempt - 1);
        await this.sleep(delay);
      }
    }

    logger.error(
      {
        err: lastError,
        webhookUrl: this.webhookUrl,
        eventCount: events.length,
        droppedTypes: Array.from(new Set(events.map((e) => e.type))),
      },
      'Metering webhook exhausted retries; dropping batch'
    );
  }
}
