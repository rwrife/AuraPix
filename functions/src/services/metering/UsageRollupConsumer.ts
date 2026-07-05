/**
 * UsageRollupConsumer — subscribes to the MeteringBus and rolls per-tenant
 * events into daily Firestore documents at
 * `tenants/{tenantId}/usageDaily/{YYYY-MM-DD}`.
 *
 * The rollup is the canonical pull surface for host billing systems
 * (see docs/features/usage-and-billing.md).
 */
import type {
  UsageMeteringBus,
  UsageMeteringCounter,
  UsageMeteringEvent,
  UsageMeteringHandler,
} from './UsageMeteringBus.js';

export interface UsageDailyDoc {
  tenantId: string;
  date: string; // YYYY-MM-DD (UTC)
  storageBytesDelta: number;
  imagesUploaded: number;
  imagesProcessed: number;
  signedUrlsIssued: number;
  editsApplied: number;
  tagsApplied: number;
  apiCalls: number;
  /**
   * Bytes egressed via `POST /v1/photos/:id/export` (issue #174). Hosts
   * use this to bill bandwidth tiers without parsing every event.
   */
  exportBytes: number;
  /**
   * Bytes egressed via share-link resolutions (issue #198). Populated
   * from `share.viewed` metering events that carry a `bytesServed` value.
   * Rolls up alongside `exportBytes` so hosts see both bandwidth flavours
   * on the same daily doc.
   */
  shareEgressBytes: number;
  /**
   * Distinct end-users seen for the tenant on this UTC day (seat-based
   * billing signal). Populated from `user.active` metering events; see
   * `docs/features/metering-events.md`.
   */
  activeUsers: number;
  /**
   * Number of requests rejected by the per-tenant rate limiter on this day
   * (issue #154). Aggregated from sampled `rate_limit.exceeded` events so
   * hosts can chart abuse without consuming the webhook stream directly.
   */
  rateLimited: number;
  /** Populated by the scheduled snapshot job; null until first snapshot. */
  storageBytesTotal: number | null;
  /** Idempotency: event IDs already applied to this doc. */
  appliedEventIds: string[];
  updatedAt: string;
}

export interface DailyDocStore {
  /**
   * Atomically read-modify-write the daily doc. The mutator receives the
   * current doc (or null) and returns the new doc; the store is responsible
   * for serializing concurrent mutations on the same key (Firestore txn or
   * equivalent).
   */
  transact(
    tenantId: string,
    date: string,
    mutator: (current: UsageDailyDoc | null) => UsageDailyDoc
  ): Promise<UsageDailyDoc>;
}

const COUNTER_FIELDS: UsageMeteringCounter[] = [
  'storageBytesDelta',
  'imagesUploaded',
  'imagesProcessed',
  'signedUrlsIssued',
  'editsApplied',
  'tagsApplied',
  'apiCalls',
  'exportBytes',
  'shareEgressBytes',
  'activeUsers',
  'rateLimited',
];

export function isoDateUtc(input: string | Date | undefined): string {
  const d = input ? new Date(input) : new Date();
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${String(input)}`);
  }
  return d.toISOString().slice(0, 10);
}

export function emptyDailyDoc(tenantId: string, date: string): UsageDailyDoc {
  return {
    tenantId,
    date,
    storageBytesDelta: 0,
    imagesUploaded: 0,
    imagesProcessed: 0,
    signedUrlsIssued: 0,
    editsApplied: 0,
    tagsApplied: 0,
    apiCalls: 0,
    exportBytes: 0,
    shareEgressBytes: 0,
    activeUsers: 0,
    rateLimited: 0,
    storageBytesTotal: null,
    appliedEventIds: [],
    updatedAt: new Date(0).toISOString(),
  };
}

export class UsageRollupConsumer {
  constructor(private readonly store: DailyDocStore) {}

  /** Apply a single event to its daily doc. */
  async apply(event: UsageMeteringEvent): Promise<UsageDailyDoc> {
    if (!event.tenantId) {
      throw new Error('UsageMeteringEvent.tenantId is required');
    }
    if (!COUNTER_FIELDS.includes(event.counter)) {
      throw new Error(`Unknown metering counter: ${event.counter}`);
    }
    if (typeof event.value !== 'number' || !Number.isFinite(event.value)) {
      throw new Error('UsageMeteringEvent.value must be a finite number');
    }

    const date = isoDateUtc(event.occurredAt);

    return this.store.transact(event.tenantId, date, (current) => {
      const base = current ?? emptyDailyDoc(event.tenantId, date);

      // Idempotency: skip if this event was already applied.
      if (event.eventId && base.appliedEventIds.includes(event.eventId)) {
        return base;
      }

      const next: UsageDailyDoc = {
        ...base,
        [event.counter]: base[event.counter] + event.value,
        appliedEventIds: event.eventId
          ? [...base.appliedEventIds, event.eventId]
          : base.appliedEventIds,
        updatedAt: new Date().toISOString(),
      };
      return next;
    });
  }

  /** Subscribe this consumer to a bus. Returns the unsubscribe handle. */
  attach(bus: UsageMeteringBus): () => void {
    const handler: UsageMeteringHandler = (event) => this.apply(event).then(() => undefined);
    return bus.subscribe(handler);
  }
}

/**
 * In-memory store, useful for tests and local-dev mode. Production uses the
 * Firestore-backed store (transactional updates on the daily doc).
 */
export class InMemoryDailyDocStore implements DailyDocStore {
  private readonly docs = new Map<string, UsageDailyDoc>();
  private locks = new Map<string, Promise<void>>();

  private key(tenantId: string, date: string): string {
    return `${tenantId}::${date}`;
  }

  async transact(
    tenantId: string,
    date: string,
    mutator: (current: UsageDailyDoc | null) => UsageDailyDoc
  ): Promise<UsageDailyDoc> {
    const key = this.key(tenantId, date);
    // Serialize per-key to mimic Firestore txn semantics.
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      key,
      prev.then(() => current)
    );

    await prev;
    try {
      const existing = this.docs.get(key) ?? null;
      const next = mutator(existing);
      this.docs.set(key, next);
      return next;
    } finally {
      release();
    }
  }

  /** Test helper. */
  get(tenantId: string, date: string): UsageDailyDoc | null {
    return this.docs.get(this.key(tenantId, date)) ?? null;
  }

  /** Test helper. */
  list(tenantId: string): UsageDailyDoc[] {
    return Array.from(this.docs.values())
      .filter((d) => d.tenantId === tenantId)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Used by snapshot job to write storageBytesTotal. */
  async setStorageBytesTotal(
    tenantId: string,
    date: string,
    totalBytes: number
  ): Promise<UsageDailyDoc> {
    return this.transact(tenantId, date, (current) => {
      const base = current ?? emptyDailyDoc(tenantId, date);
      return {
        ...base,
        storageBytesTotal: totalBytes,
        updatedAt: new Date().toISOString(),
      };
    });
  }
}
