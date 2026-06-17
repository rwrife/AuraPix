import { createHash, createHmac, randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';
import type {
  MeteringSink,
  NormalizedMeteringEvent,
} from './MeteringBus.js';
import {
  computeDeliveryExpiry,
  type WebhookDeliveryRecord,
  type WebhookDeliveryStore,
} from './WebhookDeliveryStore.js';

export interface SigningSecretSet {
  /** Currently active secret used for HMAC signing. */
  current: { secret: string; fingerprint?: string };
  /**
   * Optional previous secret kept valid during a rotation grace window
   * (issue #161). When present, the sink emits an additional signature
   * for this secret so receivers can verify with either value.
   */
  previous?: { secret: string; fingerprint?: string };
}

export type WebhookSigningSecretResolver = (
  tenantId: string
) => Promise<SigningSecretSet | null> | SigningSecretSet | null;

export interface HostWebhookSinkOptions {
  /** Endpoint to POST batched events. If unset, sink is a no-op. */
  webhookUrl?: string;
  /**
   * Process-wide signing secret used when `secretsResolver` is not
   * configured (or returns null for a tenant). Outbound deliveries
   * always need at least one secret — this is the fallback.
   */
  signingSecret: string;
  /**
   * Optional per-tenant secret resolver. When set, the sink looks up
   * the active secret(s) for the batch's tenant on each delivery. Inside
   * the rotation grace window the resolver returns both `current` and
   * `previous`, in which case the sink signs the body with each and
   * sends two comma-separated values in `X-AuraPix-Signature`:
   *   `v1=<new>,v1=<old>`
   */
  secretsResolver?: WebhookSigningSecretResolver;
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
  /**
   * Optional store for per-batch delivery observability (issue #144).
   * When set, the sink writes a record on first attempt and updates it
   * after each attempt (success or failure).
   */
  deliveryStore?: WebhookDeliveryStore;
  /** Inject batch id generation (tests). */
  batchIdFactory?: () => string;
  /**
   * How to resolve a tenant id for a batch. The bus today does not enforce
   * a single tenant per batch; if events span tenants, the most-common
   * tenantId in the batch is used. Defaults to that built-in behavior.
   */
  tenantIdResolver?: (events: NormalizedMeteringEvent[]) => string;
  /** Maximum batches retained in the in-process replay cache. Default 256. */
  recentBatchCap?: number;
}

const SIGNATURE_HEADER = 'X-AuraPix-Signature';
const IDEMPOTENCY_HEADER = 'X-AuraPix-Idempotency-Key';
const SIGNATURE_VERSION = 'v1';
const ERROR_MESSAGE_MAX = 500;

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

/** SHA-256 hex of the raw body. Stored on delivery records (no body kept). */
export function computeContentHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function pickTenantId(events: NormalizedMeteringEvent[]): string {
  if (events.length === 0) return 'lib:unknown';
  if (events.length === 1) return events[0]!.tenantId;
  const counts = new Map<string, number>();
  for (const e of events) {
    counts.set(e.tenantId, (counts.get(e.tenantId) ?? 0) + 1);
  }
  let bestId = events[0]!.tenantId;
  let bestCount = -1;
  for (const [id, n] of counts) {
    if (n > bestCount) {
      bestCount = n;
      bestId = id;
    }
  }
  return bestId;
}

function truncateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > ERROR_MESSAGE_MAX
    ? msg.slice(0, ERROR_MESSAGE_MAX)
    : msg;
}

/**
 * Sink that POSTs batched metering events to a host-supplied webhook URL.
 *
 * - HMAC-SHA256 signature in `X-AuraPix-Signature` header.
 * - Stable batch id sent in `X-AuraPix-Idempotency-Key` so hosts can dedupe
 *   (especially across manual replays).
 * - Retries up to `maxAttempts` with exponential backoff.
 * - Drops the batch on exhaustion and logs; never throws.
 * - When `webhookUrl` is unset, behaves as a no-op.
 * - When a `deliveryStore` is configured, persists a delivery record per
 *   batch and updates it after each attempt (see issue #144).
 */
export class HostWebhookSink implements MeteringSink {
  private readonly webhookUrl?: string;
  private readonly signingSecret: string;
  private readonly secretsResolver?: WebhookSigningSecretResolver;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly deliveryStore?: WebhookDeliveryStore;
  private readonly batchIdFactory: () => string;
  private readonly tenantIdResolver: (events: NormalizedMeteringEvent[]) => string;
  /** In-flight batchIds (idempotency guard for concurrent replay). */
  private readonly inflightBatches = new Set<string>();
  /**
   * Small bounded cache of recently-sent batches keyed by batchId, used to
   * service manual replay (issue #144). Bodies are intentionally NOT
   * persisted to Firestore; this cache lives only in-process.
   */
  private readonly recentBatches = new Map<string, NormalizedMeteringEvent[]>();
  private readonly recentBatchCap: number;

  constructor(opts: HostWebhookSinkOptions) {
    this.webhookUrl = opts.webhookUrl;
    this.signingSecret = opts.signingSecret;
    this.secretsResolver = opts.secretsResolver;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 200;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.deliveryStore = opts.deliveryStore;
    this.batchIdFactory = opts.batchIdFactory ?? (() => randomUUID());
    this.tenantIdResolver = opts.tenantIdResolver ?? pickTenantId;
    this.recentBatchCap = opts.recentBatchCap ?? 256;
  }

  /** Look up the cached events for a recently-sent batch (replay helper). */
  getCachedBatch(batchId: string): NormalizedMeteringEvent[] | undefined {
    const events = this.recentBatches.get(batchId);
    return events ? events.map((e) => ({ ...e })) : undefined;
  }

  private cacheBatch(batchId: string, events: NormalizedMeteringEvent[]): void {
    // FIFO eviction.
    if (this.recentBatches.has(batchId)) {
      this.recentBatches.delete(batchId);
    } else if (this.recentBatches.size >= this.recentBatchCap) {
      const oldest = this.recentBatches.keys().next().value;
      if (oldest !== undefined) this.recentBatches.delete(oldest);
    }
    this.recentBatches.set(batchId, events.map((e) => ({ ...e })));
  }

  /** True when a webhook URL is configured. */
  get enabled(): boolean {
    return Boolean(this.webhookUrl);
  }

  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    if (!this.webhookUrl || events.length === 0) {
      return;
    }
    const batchId = this.batchIdFactory();
    await this.sendBatch(events, batchId, /* isReplay */ false);
  }

  /**
   * Re-send a previously-recorded batch. Reconstructs the body from the
   * provided events, reuses the original `batchId` (so the idempotency
   * header matches), and updates the existing delivery record in place.
   *
   * Concurrent calls for the same `batchId` are coalesced: the second call
   * returns immediately without POSTing.
   *
   * Returns the latest delivery record (after the replay attempts) or
   * `null` if no store is configured.
   */
  async replayBatch(
    events: NormalizedMeteringEvent[],
    batchId: string
  ): Promise<WebhookDeliveryRecord | null> {
    if (!this.webhookUrl) {
      return this.deliveryStore?.get(this.tenantIdResolver(events), batchId) ?? null;
    }
    await this.sendBatch(events, batchId, /* isReplay */ true);
    if (!this.deliveryStore) return null;
    return this.deliveryStore.get(this.tenantIdResolver(events), batchId);
  }

  private async resolveSecretsForBatch(
    tenantId: string
  ): Promise<SigningSecretSet> {
    if (this.secretsResolver) {
      try {
        const resolved = await this.secretsResolver(tenantId);
        if (resolved && resolved.current && resolved.current.secret) {
          return resolved;
        }
      } catch (err) {
        logger.warn(
          { err, tenantId },
          'secretsResolver threw; falling back to process-wide signing secret'
        );
      }
    }
    return { current: { secret: this.signingSecret } };
  }

  private async sendBatch(
    events: NormalizedMeteringEvent[],
    batchId: string,
    isReplay: boolean
  ): Promise<void> {
    if (this.inflightBatches.has(batchId)) {
      // Idempotency: another caller is already POSTing this batch.
      logger.info(
        { batchId, isReplay },
        'Webhook batch already in flight; skipping duplicate send'
      );
      return;
    }
    this.inflightBatches.add(batchId);
    try {
      // Cache the event payload so a manual replay can rebuild the body.
      this.cacheBatch(batchId, events);
      const sentAt = new Date().toISOString();
      const body = JSON.stringify({
        version: SIGNATURE_VERSION,
        sentAt,
        batchId,
        events,
      });
      const tenantId = this.tenantIdResolver(events);
      const secrets = await this.resolveSecretsForBatch(tenantId);
      const signatureParts: string[] = [
        computeWebhookSignature(body, secrets.current.secret),
      ];
      const signedFingerprints: string[] = secrets.current.fingerprint
        ? [secrets.current.fingerprint]
        : [];
      if (secrets.previous && secrets.previous.secret) {
        signatureParts.push(
          computeWebhookSignature(body, secrets.previous.secret)
        );
        if (secrets.previous.fingerprint) {
          signedFingerprints.push(secrets.previous.fingerprint);
        }
      }
      const signature = signatureParts.join(',');
      const contentHash = computeContentHash(body);

      // Seed (or refresh) the delivery record up front so failures are visible.
      if (this.deliveryStore) {
        if (isReplay) {
          await this.deliveryStore.update(tenantId, batchId, {
            status: 'pending',
            updatedAt: sentAt,
            ...(signedFingerprints.length > 0
              ? { signedFingerprints }
              : {}),
          });
        } else {
          const record: WebhookDeliveryRecord = {
            batchId,
            tenantId,
            sentAt,
            statusCode: null,
            ok: false,
            attemptCount: 0,
            eventCount: events.length,
            contentHash,
            status: 'pending',
            updatedAt: sentAt,
            expiresAt: computeDeliveryExpiry(sentAt),
            ...(signedFingerprints.length > 0
              ? { signedFingerprints }
              : {}),
          };
          await this.deliveryStore.create(record);
        }
      }

      let lastError: unknown = null;
      let lastStatus: number | null = null;
      let attemptCount = 0;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        attemptCount = attempt;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const response = await this.fetchImpl(this.webhookUrl!, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [SIGNATURE_HEADER]: signature,
              [IDEMPOTENCY_HEADER]: batchId,
            },
            body,
            signal: controller.signal,
          });
          lastStatus = response.status;
          if (response.ok) {
            await this.recordOutcome(tenantId, batchId, {
              status: 'ok',
              statusCode: response.status,
              ok: true,
              attemptCount,
              errorMessage: undefined,
            });
            return;
          }
          lastError = new Error(
            `Webhook returned non-2xx status ${response.status}`
          );
          logger.warn(
            {
              attempt,
              batchId,
              status: response.status,
              webhookUrl: this.webhookUrl,
              eventCount: events.length,
              isReplay,
            },
            'Metering webhook returned non-2xx; will retry if attempts remain'
          );
        } catch (err) {
          lastError = err;
          logger.warn(
            {
              attempt,
              batchId,
              err,
              webhookUrl: this.webhookUrl,
              eventCount: events.length,
              isReplay,
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
          batchId,
          webhookUrl: this.webhookUrl,
          eventCount: events.length,
          droppedTypes: Array.from(new Set(events.map((e) => e.type))),
          isReplay,
        },
        'Metering webhook exhausted retries; dropping batch'
      );
      await this.recordOutcome(tenantId, batchId, {
        status: 'failed',
        statusCode: lastStatus,
        ok: false,
        attemptCount,
        errorMessage: truncateError(lastError),
      });
    } finally {
      this.inflightBatches.delete(batchId);
    }
  }

  private async recordOutcome(
    tenantId: string,
    batchId: string,
    patch: {
      status: 'ok' | 'failed';
      statusCode: number | null;
      ok: boolean;
      attemptCount: number;
      errorMessage?: string;
    }
  ): Promise<void> {
    if (!this.deliveryStore) return;
    try {
      await this.deliveryStore.update(tenantId, batchId, {
        ...patch,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn(
        { err, batchId, tenantId },
        'Failed to persist webhook delivery record'
      );
    }
  }
}
