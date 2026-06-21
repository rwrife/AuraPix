import { logger } from '../../utils/logger.js';
import type { RegisteredEventName } from './eventCatalog.js';

/**
 * Catalogue of billable event types emitted by AuraPix.
 *
 * Derived from the single source of truth in `eventCatalog.ts` (issue
 * #176). Adding a new event name here directly is impossible — you must
 * register the event in `EVENT_CATALOG` first, which gives compile-time
 * guarantees that every emitted name has an associated payload schema
 * and appears in the `GET /v1/host/webhook-events` response.
 *
 * Hosts that resell AuraPix use these to drive metered billing.
 */
export type MeteringEventType = RegisteredEventName;

export interface MeteringEvent {
  /**
   * Tenant identifier. Required so hosts can route per-customer.
   * If a true tenantId is not yet wired through (see tenant issue),
   * callers fall back to the libraryId, prefixed with `lib:`.
   */
  tenantId: string;
  type: MeteringEventType;
  /** Number of units (default 1). */
  count?: number;
  /** Byte size, where meaningful (uploads, derivatives). */
  bytes?: number;
  /** Optional resource id (photoId, derivativeKey, keyId, ...). */
  resourceId?: string;
  /** ISO-8601 timestamp; defaults to now if omitted. */
  occurredAt?: string;
  /** Free-form metadata for routing or analytics. Keep small. */
  meta?: Record<string, unknown>;
}

/**
 * Normalized form of a MeteringEvent ready for transport.
 */
export interface NormalizedMeteringEvent extends MeteringEvent {
  count: number;
  occurredAt: string;
}

export interface MeteringSink {
  /**
   * Receive a batch of events. MUST NOT throw to the caller.
   * Should perform its own retry/backoff and drop on exhaustion.
   */
  deliver(events: NormalizedMeteringEvent[]): Promise<void>;
}

export interface MeteringBusOptions {
  /** Max events buffered before forcing a flush. Default 50. */
  maxBatchSize?: number;
  /** Max time (ms) between flushes when queue is non-empty. Default 1000. */
  flushIntervalMs?: number;
  /** Sink that receives flushed events. */
  sink: MeteringSink;
}

/**
 * In-memory typed event bus that batches metering events to a sink.
 *
 * Emit is fire-and-forget and never throws. The bus self-flushes on
 * batch size or interval, whichever comes first.
 */
export class MeteringBus {
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly sink: MeteringSink;
  private queue: NormalizedMeteringEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(opts: MeteringBusOptions) {
    this.maxBatchSize = opts.maxBatchSize ?? 50;
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
    this.sink = opts.sink;
  }

  /**
   * Enqueue a metering event. Fire-and-forget; never throws.
   */
  emit(event: MeteringEvent): void {
    try {
      const normalized: NormalizedMeteringEvent = {
        ...event,
        count: event.count ?? 1,
        occurredAt: event.occurredAt ?? new Date().toISOString(),
      };
      this.queue.push(normalized);

      if (this.queue.length >= this.maxBatchSize) {
        // Flush immediately on batch threshold.
        void this.flush();
        return;
      }

      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, this.flushIntervalMs);
        // Allow Node to exit even if the bus has a pending timer.
        if (typeof this.timer.unref === 'function') {
          this.timer.unref();
        }
      }
    } catch (err) {
      logger.warn({ err }, 'MeteringBus.emit failed');
    }
  }

  /**
   * Flush all queued events to the sink. Safe to await; never throws.
   * Concurrent flushes are coalesced.
   */
  async flush(): Promise<void> {
    if (this.inflight) {
      return this.inflight;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) {
      return;
    }
    const batch = this.queue;
    this.queue = [];
    this.inflight = (async () => {
      try {
        await this.sink.deliver(batch);
      } catch (err) {
        // Sink contract is no-throw; this is defensive.
        logger.warn({ err, batchSize: batch.length }, 'MeteringBus sink threw');
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /**
   * Stop the periodic timer and flush remaining events.
   */
  async shutdown(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** Test/observability helper. */
  pendingCount(): number {
    return this.queue.length;
  }
}

/**
 * A sink that drops every event. Used when metering is disabled.
 */
export class NoopMeteringSink implements MeteringSink {
  async deliver(_events: NormalizedMeteringEvent[]): Promise<void> {
    // intentionally empty
  }
}
