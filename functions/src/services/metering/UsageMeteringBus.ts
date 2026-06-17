/**
 * UsageMeteringBus — pub/sub surface for tenant usage events consumed by the
 * daily usage rollups (issue #133).
 *
 * This is an intentionally minimal interface, decoupled from the broader
 * `MeteringBus` batching/sink machinery used for host webhook fanout
 * (issue #137). The two can coexist: production wiring can bridge events
 * from the batching bus into this pub/sub bus by translating the event
 * shape into the counter/value form below.
 *
 * A production implementation can swap the in-memory bus for Pub/Sub,
 * EventBridge, etc.; consumers only depend on the `subscribe`/`publish`
 * shape below.
 */

export type UsageMeteringCounter =
  | 'storageBytesDelta'
  | 'imagesUploaded'
  | 'imagesProcessed'
  | 'signedUrlsIssued'
  | 'editsApplied'
  | 'tagsApplied'
  | 'apiCalls'
  | 'exportBytes'
  | 'rateLimited';

export interface UsageMeteringEvent {
  /** Tenant the event applies to. */
  tenantId: string;
  /** Which counter to increment. */
  counter: UsageMeteringCounter;
  /** Increment value (may be negative for storageBytesDelta after deletes). */
  value: number;
  /**
   * ISO-8601 timestamp; consumer uses this to pick the YYYY-MM-DD doc.
   * Defaults to now() if omitted.
   */
  occurredAt?: string;
  /**
   * Optional idempotency key; consumer uses it to skip duplicate events on
   * retry. Required when the publisher might at-least-once deliver.
   */
  eventId?: string;
  /** Optional arbitrary metadata (not persisted). */
  meta?: Record<string, unknown>;
}

export type UsageMeteringHandler = (event: UsageMeteringEvent) => Promise<void> | void;

export interface UsageMeteringBus {
  publish(event: UsageMeteringEvent): Promise<void>;
  subscribe(handler: UsageMeteringHandler): () => void;
}

/**
 * In-memory bus. Suitable for tests and the local-dev runtime; in Firebase
 * mode this can be replaced by a Pub/Sub-backed bus that fans events out to
 * the same consumer handlers.
 */
export class InMemoryUsageMeteringBus implements UsageMeteringBus {
  private readonly handlers = new Set<UsageMeteringHandler>();

  async publish(event: UsageMeteringEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
  }

  subscribe(handler: UsageMeteringHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
