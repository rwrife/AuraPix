/**
 * WebhookDeliveryStore — persistence for outbound host-webhook delivery
 * records. One record per batch (NOT per attempt within a batch); the record
 * is updated in place as attempts succeed or fail.
 *
 * Records live under `tenants/{tenantId}/webhookDeliveries/{batchId}` in
 * Firestore. A Firestore TTL policy on `expiresAt` purges records after
 * 30 days. We deliberately do NOT persist event bodies (privacy + cost);
 * `contentHash` is stored so an operator can correlate a record with a
 * specific payload if the upstream caller logs the same hash.
 *
 * See docs/features/metering-events.md → "Delivery observability".
 *
 * Tracking issue: #144.
 */

export type WebhookDeliveryStatus = 'pending' | 'ok' | 'failed';

export interface WebhookDeliveryRecord {
  /** Stable batch id (uuid). Used as Firestore doc id and idempotency key. */
  batchId: string;
  /** Tenant the batch was destined for. */
  tenantId: string;
  /** ISO-8601 of the first POST attempt. */
  sentAt: string;
  /** Last observed HTTP status code, or null if no response (network err). */
  statusCode: number | null;
  /** Convenience boolean: true iff statusCode is 2xx. */
  ok: boolean;
  /** Number of POST attempts so far (success or failure). */
  attemptCount: number;
  /** Number of metering events in the batch. */
  eventCount: number;
  /** SHA-256 hex digest of the raw POST body. */
  contentHash: string;
  /** Current state. `pending` is transient (in-flight). */
  status: WebhookDeliveryStatus;
  /** Truncated error message on the most recent failure. */
  errorMessage?: string;
  /** ISO-8601 of last attempt (success or failure). */
  updatedAt: string;
  /** ISO-8601 expiry for Firestore TTL (30 days from sentAt). */
  expiresAt: string;
  /**
   * Fingerprints (truncated SHA-256) of the signing secret(s) used to
   * sign this batch. During a rotation grace window the sink signs with
   * BOTH secrets; this array contains an entry per signature value in
   * the order they appear in `X-AuraPix-Signature` (`new` first, `old`
   * second). Empty when no per-tenant fingerprints are available.
   */
  signedFingerprints?: string[];
}

export interface WebhookDeliveryListOptions {
  /** Filter by status. */
  status?: WebhookDeliveryStatus;
  /** Inclusive lower bound on `sentAt` (ISO-8601). */
  since?: string;
  /** Max records to return. Default 50, capped at 200. */
  limit?: number;
  /** Opaque pagination cursor (batchId of last item from previous page). */
  cursor?: string;
}

export interface WebhookDeliveryListResult {
  items: WebhookDeliveryRecord[];
  /** Set when more results may exist; pass as `cursor` to the next call. */
  nextCursor?: string;
}

export interface WebhookDeliveryStore {
  /** Insert a new delivery record (or no-op if one already exists for batchId). */
  create(record: WebhookDeliveryRecord): Promise<void>;
  /** Update an existing delivery record by batchId. */
  update(
    tenantId: string,
    batchId: string,
    patch: Partial<Omit<WebhookDeliveryRecord, 'batchId' | 'tenantId'>>
  ): Promise<WebhookDeliveryRecord | null>;
  /** Fetch a single record (returns null if missing). */
  get(
    tenantId: string,
    batchId: string
  ): Promise<WebhookDeliveryRecord | null>;
  /** List records for a tenant, newest first. */
  list(
    tenantId: string,
    opts?: WebhookDeliveryListOptions
  ): Promise<WebhookDeliveryListResult>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * In-memory store. Used by local-mode/dev and by tests; production swaps in
 * a Firestore-backed implementation in a follow-up.
 */
export class InMemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  // tenantId -> batchId -> record
  private readonly byTenant = new Map<
    string,
    Map<string, WebhookDeliveryRecord>
  >();

  async create(record: WebhookDeliveryRecord): Promise<void> {
    const bucket = this.bucket(record.tenantId);
    if (!bucket.has(record.batchId)) {
      bucket.set(record.batchId, { ...record });
    }
  }

  async update(
    tenantId: string,
    batchId: string,
    patch: Partial<Omit<WebhookDeliveryRecord, 'batchId' | 'tenantId'>>
  ): Promise<WebhookDeliveryRecord | null> {
    const bucket = this.byTenant.get(tenantId);
    if (!bucket) return null;
    const existing = bucket.get(batchId);
    if (!existing) return null;
    const next: WebhookDeliveryRecord = { ...existing, ...patch };
    bucket.set(batchId, next);
    return { ...next };
  }

  async get(
    tenantId: string,
    batchId: string
  ): Promise<WebhookDeliveryRecord | null> {
    const rec = this.byTenant.get(tenantId)?.get(batchId);
    return rec ? { ...rec } : null;
  }

  async list(
    tenantId: string,
    opts: WebhookDeliveryListOptions = {}
  ): Promise<WebhookDeliveryListResult> {
    const bucket = this.byTenant.get(tenantId);
    if (!bucket) return { items: [] };

    const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
    let all = Array.from(bucket.values());
    if (opts.status) {
      all = all.filter((r) => r.status === opts.status);
    }
    if (opts.since) {
      const since = opts.since;
      all = all.filter((r) => r.sentAt >= since);
    }
    // Newest first by sentAt; batchId tiebreak for stable order.
    all.sort((a, b) => {
      if (a.sentAt === b.sentAt) return a.batchId.localeCompare(b.batchId);
      return b.sentAt.localeCompare(a.sentAt);
    });

    let startIdx = 0;
    if (opts.cursor) {
      const idx = all.findIndex((r) => r.batchId === opts.cursor);
      startIdx = idx >= 0 ? idx + 1 : 0;
    }
    const page = all.slice(startIdx, startIdx + limit);
    const result: WebhookDeliveryListResult = { items: page.map((r) => ({ ...r })) };
    if (startIdx + page.length < all.length) {
      result.nextCursor = page[page.length - 1]!.batchId;
    }
    return result;
  }

  private bucket(tenantId: string): Map<string, WebhookDeliveryRecord> {
    let b = this.byTenant.get(tenantId);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenantId, b);
    }
    return b;
  }
}

export const WEBHOOK_DELIVERIES_COLLECTION = 'webhookDeliveries';
export const WEBHOOK_DELIVERY_TTL_DAYS = 30;

/** Compute a 30-day TTL expiry from a sentAt timestamp. */
export function computeDeliveryExpiry(sentAtIso: string): string {
  const t = new Date(sentAtIso).getTime();
  const expiry = new Date(t + WEBHOOK_DELIVERY_TTL_DAYS * 24 * 60 * 60 * 1000);
  return expiry.toISOString();
}
