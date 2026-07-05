/**
 * ShareViewStore \u2014 storage for share-link view rows and per-link
 * aggregate counters (issue #198).
 *
 * Two data shapes:
 *
 * 1. **Raw view rows** \u2014 append-only records used for de-duplication and
 *    for the last-7-days time series on the analytics endpoint. Retained
 *    for 90 days; older rows are dropped on read.
 *
 * 2. **Aggregate counters** \u2014 per-link running totals (`totalViews`,
 *    `uniqueViewers`, `bytesServed`, `lastViewedAt`). These persist
 *    indefinitely on the link doc so hosts can bill even after raw rows
 *    have aged out.
 *
 * The concrete production store lives on top of {@link DataAdapter}
 * (`shareViews/{viewId}` + `shareLinkAggregates/{linkId}` collections).
 * The in-memory implementation here is used by tests and local-dev mode.
 *
 * See:
 *   - services/sharing/ShareViewTracker.ts \u2014 the record path
 *   - routes/shareLinkAnalyticsV1.ts        \u2014 the read path
 */

/**
 * How long raw view rows are retained. Older rows are dropped when the
 * store surfaces a range query \u2014 the aggregate counters keep the
 * historical totals.
 */
export const SHARE_VIEW_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * De-duplication window. Two views for the same `(linkId, ipHash, uaHash)`
 * within this window collapse into a single view row and a single
 * `share.viewed` metering event. Bytes are still charged for the *first*
 * request in the window \u2014 subsequent requests in the same window are
 * treated as the browser re-fetching sub-resources of the same page load.
 */
export const SHARE_VIEW_DEDUP_WINDOW_MS = 60_000;

export interface ShareViewRow {
  /** Stable row id (deterministic when possible so retries collapse). */
  id: string;
  linkId: string;
  tenantId: string;
  /** ISO-8601 timestamp. */
  viewedAt: string;
  /** HMAC(ip, tenantSecret) \u2014 non-reversible; used for de-dup only. */
  ipHash: string;
  /** HMAC(userAgent, tenantSecret) \u2014 non-reversible. */
  uaHash: string;
  /**
   * Referrer host (`URL.host`) if the request supplied a `Referer`
   * header, else `null`. We deliberately do NOT store the full referrer
   * URL \u2014 hosts should not be able to reconstruct the query string a
   * viewer clicked from.
   */
  referrerHost: string | null;
  /** Bytes served for this view. `null` when the size is unknown. */
  bytesServed: number | null;
}

export interface ShareLinkAggregate {
  linkId: string;
  tenantId: string;
  totalViews: number;
  /**
   * Distinct `(ipHash, uaHash)` seen for the lifetime of the link. Because
   * the aggregate is updated inline with each view, this is an
   * append-only unique-viewer count derived from a per-link set of seen
   * hashes. The set itself is not exposed on this doc \u2014 it lives in
   * the raw view rows (and behind the aggregate's `uniqueViewers`
   * counter, which is a monotone lower bound after 90-day retention
   * kicks in).
   */
  uniqueViewers: number;
  bytesServed: number;
  lastViewedAt: string | null;
  /** ISO-8601 timestamp of the most recent aggregate update. */
  updatedAt: string;
}

export interface RecordViewInput {
  linkId: string;
  tenantId: string;
  viewedAt: string;
  ipHash: string;
  uaHash: string;
  referrerHost: string | null;
  bytesServed: number | null;
}

export interface RecordViewResult {
  /**
   * `true` when the input landed as a new view row (not deduped by the
   * 60-second window). Callers only emit `share.viewed` metering events
   * and increment aggregates when this is `true`.
   */
  recorded: boolean;
  /** The row that now represents this view (either new or the dedup match). */
  row: ShareViewRow;
  /** Snapshot of the aggregate after this view. */
  aggregate: ShareLinkAggregate;
}

export interface ShareViewStore {
  /**
   * Record a view. Implementations MUST enforce the
   * {@link SHARE_VIEW_DEDUP_WINDOW_MS} de-dup window \u2014 returning
   * `recorded: false` on a hit within the window \u2014 and MUST update
   * the aggregate atomically for accepted views.
   */
  recordView(input: RecordViewInput): Promise<RecordViewResult>;

  /** Fetch the aggregate for a link. `null` when the link has no views yet. */
  getAggregate(
    tenantId: string,
    linkId: string
  ): Promise<ShareLinkAggregate | null>;

  /**
   * Enumerate view rows for a link between `from` and `to` (inclusive,
   * ISO-8601 timestamps). Rows older than {@link SHARE_VIEW_RETENTION_MS}
   * are dropped by the store; callers should not depend on them.
   */
  listViews(
    tenantId: string,
    linkId: string,
    from: string,
    to: string
  ): Promise<ShareViewRow[]>;
}

interface StoredRow extends ShareViewRow {
  /** Cached at insert to avoid re-parsing on every retention sweep. */
  viewedAtMs: number;
}

/**
 * In-memory implementation of {@link ShareViewStore}. Suitable for tests
 * and local-dev mode. Production wiring uses a `DataAdapter`-backed store
 * (planned as a follow-up so we don't couple this issue to the Firestore
 * index migration \u2014 the interface above is stable).
 */
export class InMemoryShareViewStore implements ShareViewStore {
  private readonly rows = new Map<string, StoredRow[]>();
  private readonly aggregates = new Map<string, ShareLinkAggregate>();
  /**
   * Track `(ipHash|uaHash)` fingerprints seen per link so unique viewer
   * counts survive the raw-row retention window. Trimmed via
   * {@link pruneUnique} when it grows past 100k entries per link.
   */
  private readonly uniqueSets = new Map<string, Set<string>>();

  private key(tenantId: string, linkId: string): string {
    return `${tenantId}::${linkId}`;
  }

  private uniqueKey(ipHash: string, uaHash: string): string {
    return `${ipHash}|${uaHash}`;
  }

  async recordView(input: RecordViewInput): Promise<RecordViewResult> {
    const key = this.key(input.tenantId, input.linkId);
    const now = new Date(input.viewedAt).getTime();
    if (!Number.isFinite(now)) {
      throw new Error(`ShareViewStore.recordView: invalid viewedAt ${input.viewedAt}`);
    }

    const rows = this.rows.get(key) ?? [];
    this.pruneRetention(rows, now);

    // De-dup: any row within the window for the same fingerprint collapses.
    const cutoff = now - SHARE_VIEW_DEDUP_WINDOW_MS;
    const dedupHit = rows.find(
      (r) =>
        r.ipHash === input.ipHash &&
        r.uaHash === input.uaHash &&
        r.viewedAtMs >= cutoff
    );
    if (dedupHit) {
      const aggregate = this.getAggregateSync(input.tenantId, input.linkId);
      return { recorded: false, row: this.toRow(dedupHit), aggregate };
    }

    const row: StoredRow = {
      id: `${input.linkId}-${now}-${Math.random().toString(36).slice(2, 8)}`,
      linkId: input.linkId,
      tenantId: input.tenantId,
      viewedAt: input.viewedAt,
      viewedAtMs: now,
      ipHash: input.ipHash,
      uaHash: input.uaHash,
      referrerHost: input.referrerHost,
      bytesServed: input.bytesServed,
    };
    rows.push(row);
    this.rows.set(key, rows);

    // Update unique-viewers set.
    const uniqueKey = this.uniqueKey(input.ipHash, input.uaHash);
    let uniques = this.uniqueSets.get(key);
    if (!uniques) {
      uniques = new Set<string>();
      this.uniqueSets.set(key, uniques);
    }
    const wasNewUnique = !uniques.has(uniqueKey);
    uniques.add(uniqueKey);

    // Update aggregate.
    const existing = this.aggregates.get(key) ?? {
      linkId: input.linkId,
      tenantId: input.tenantId,
      totalViews: 0,
      uniqueViewers: 0,
      bytesServed: 0,
      lastViewedAt: null,
      updatedAt: new Date(0).toISOString(),
    };
    const bytesDelta = input.bytesServed ?? 0;
    const next: ShareLinkAggregate = {
      ...existing,
      totalViews: existing.totalViews + 1,
      uniqueViewers: existing.uniqueViewers + (wasNewUnique ? 1 : 0),
      bytesServed: existing.bytesServed + Math.max(0, bytesDelta),
      lastViewedAt: input.viewedAt,
      updatedAt: new Date().toISOString(),
    };
    this.aggregates.set(key, next);

    return { recorded: true, row: this.toRow(row), aggregate: next };
  }

  async getAggregate(
    tenantId: string,
    linkId: string
  ): Promise<ShareLinkAggregate | null> {
    return this.aggregates.get(this.key(tenantId, linkId)) ?? null;
  }

  async listViews(
    tenantId: string,
    linkId: string,
    from: string,
    to: string
  ): Promise<ShareViewRow[]> {
    const key = this.key(tenantId, linkId);
    const rows = this.rows.get(key) ?? [];
    const nowMs = Date.now();
    this.pruneRetention(rows, nowMs);

    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new Error(
        `ShareViewStore.listViews: invalid range from=${from} to=${to}`
      );
    }
    return rows
      .filter((r) => r.viewedAtMs >= fromMs && r.viewedAtMs <= toMs)
      .map((r) => this.toRow(r))
      .sort((a, b) => a.viewedAt.localeCompare(b.viewedAt));
  }

  private getAggregateSync(
    tenantId: string,
    linkId: string
  ): ShareLinkAggregate {
    return (
      this.aggregates.get(this.key(tenantId, linkId)) ?? {
        linkId,
        tenantId,
        totalViews: 0,
        uniqueViewers: 0,
        bytesServed: 0,
        lastViewedAt: null,
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  private pruneRetention(rows: StoredRow[], nowMs: number): void {
    const cutoff = nowMs - SHARE_VIEW_RETENTION_MS;
    if (rows.length === 0 || rows[0]!.viewedAtMs >= cutoff) return;
    // Drop the leading run of expired rows in place. We keep insertion
    // order so `rows[0]` is always the oldest.
    let dropCount = 0;
    while (dropCount < rows.length && rows[dropCount]!.viewedAtMs < cutoff) {
      dropCount += 1;
    }
    if (dropCount > 0) {
      rows.splice(0, dropCount);
    }
  }

  private toRow(r: StoredRow): ShareViewRow {
    // Strip the internal `viewedAtMs` cache before handing rows to callers.
    const { viewedAtMs: _viewedAtMs, ...pub } = r;
    void _viewedAtMs;
    return pub;
  }
}
