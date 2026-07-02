/**
 * ShareViewTracker \u2014 records views of share links and emits the
 * `share.viewed` metering event (issue #198).
 *
 * The tracker is invoked from any code path that resolves a share link
 * successfully \u2014 today that means {@link ImageAuthorizer.checkShareAccess}
 * (which serves the underlying media fetch). It:
 *
 *   1. HMACs the caller's IP and user-agent with a per-tenant secret so
 *      the raw values are never persisted.
 *   2. Delegates to {@link ShareViewStore} which enforces the 60-second
 *      de-dup window per `(linkId, ipHash, uaHash)`.
 *   3. On a *new* view (not deduped) emits `share.viewed` with
 *      `bytesServed` + `referrerHost` on the shared MeteringBus and
 *      publishes a `shareEgressBytes` counter increment onto the
 *      UsageMeteringBus so the value rolls into the daily usage doc.
 *
 * Failures are swallowed \u2014 view tracking must never break the media
 * response.
 */
import { createHmac } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import {
  emitMeteringEvent,
  resolveTenantId,
} from '../metering/index.js';
import type { UsageMeteringBus } from '../metering/UsageMeteringBus.js';
import type {
  RecordViewInput,
  RecordViewResult,
  ShareViewStore,
} from './ShareViewStore.js';

export interface ShareViewTrackerOptions {
  store: ShareViewStore;
  /**
   * Master secret used to derive the per-tenant HMAC seed. Callers pass
   * the same secret used elsewhere (typically `signingConfig.masterSecret`)
   * so the derived per-tenant secret is stable across process restarts.
   */
  hashSecret: string;
  /**
   * Optional usage bus. When provided the tracker publishes
   * `shareEgressBytes` increments so `bytesServed` shows up on
   * `/v1/tenants/:id/usage` alongside `exportBytes`.
   */
  usageBus?: UsageMeteringBus | null;
  /** Override for tests (defaults to `new Date().toISOString()`). */
  now?: () => Date;
}

export interface RecordShareViewInput {
  tenantId: string;
  linkId: string;
  /**
   * Client IP as reported by the request. Empty string / undefined is
   * accepted (hashed as `""`) so view tracking never crashes on missing
   * proxy headers.
   */
  ip?: string | null;
  /** User-agent string. Same acceptance rules as `ip`. */
  userAgent?: string | null;
  /** Full `Referer` header value, if any. */
  referrer?: string | null;
  /**
   * Bytes about to be served for this view. `null` when the response
   * size is unknown at auth time (e.g. streaming). Only recorded when
   * the view is *not* deduped.
   */
  bytesServed?: number | null;
  /**
   * Optional resource hint used for metering event `meta` (photoId /
   * libraryId / grantType). Purely observational.
   */
  meta?: {
    photoId?: string;
    libraryId?: string;
    grantType?: 'album' | 'photo' | 'library';
  };
}

/**
 * Parse a `Referer` value into a bare host (no port, no path). Returns
 * `null` when the value is missing, unparseable, or a `data:` / `file:`
 * URL that has no host we can bill against.
 */
export function parseReferrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    return url.host || null;
  } catch {
    return null;
  }
}

export class ShareViewTracker {
  private readonly store: ShareViewStore;
  private readonly hashSecret: string;
  private readonly usageBus: UsageMeteringBus | null;
  private readonly now: () => Date;

  constructor(opts: ShareViewTrackerOptions) {
    this.store = opts.store;
    this.hashSecret = opts.hashSecret;
    this.usageBus = opts.usageBus ?? null;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Derive the per-tenant HMAC key. Deterministic so the same IP hashes
   * consistently across process restarts, but the master secret never
   * leaves the process. Because the derivation includes `tenantId`, the
   * same IP under two different tenants produces two *different* hashes
   * \u2014 the per-tenant isolation guarantee in issue #198.
   */
  private tenantSecret(tenantId: string): Buffer {
    return createHmac('sha256', this.hashSecret)
      .update(`share-view/${tenantId}`)
      .digest();
  }

  /**
   * Compute an HMAC hex digest for `value` using the per-tenant secret.
   * Empty / missing inputs are hashed as the empty string so the store's
   * de-dup key is stable.
   */
  hash(tenantId: string, value: string | null | undefined): string {
    const secret = this.tenantSecret(tenantId);
    return createHmac('sha256', secret).update(value ?? '').digest('hex');
  }

  /**
   * Record a share-link view. Fire-and-forget \u2014 never throws; failures
   * are logged and swallowed.
   */
  async record(input: RecordShareViewInput): Promise<RecordViewResult | null> {
    try {
      const tenantId = input.tenantId;
      if (!tenantId || !input.linkId) {
        return null;
      }
      const now = this.now();
      const viewedAt = now.toISOString();
      const ipHash = this.hash(tenantId, input.ip);
      const uaHash = this.hash(tenantId, input.userAgent);
      const referrerHost = parseReferrerHost(input.referrer);
      const bytesServed =
        typeof input.bytesServed === 'number' && Number.isFinite(input.bytesServed)
          ? Math.max(0, Math.floor(input.bytesServed))
          : null;

      const rec: RecordViewInput = {
        linkId: input.linkId,
        tenantId,
        viewedAt,
        ipHash,
        uaHash,
        referrerHost,
        bytesServed,
      };
      const result = await this.store.recordView(rec);

      if (result.recorded) {
        // Emit the billable `share.viewed` event exactly once per de-duped
        // view. Deduped views are billed against the first request in the
        // window (subsequent requests within 60s = same page load).
        emitMeteringEvent({
          tenantId: resolveTenantId({ tenantId, libraryId: input.meta?.libraryId }),
          type: 'share.viewed',
          count: 1,
          resourceId: input.linkId,
          meta: {
            ...(input.meta?.photoId ? { photoId: input.meta.photoId } : {}),
            ...(input.meta?.libraryId ? { libraryId: input.meta.libraryId } : {}),
            ...(input.meta?.grantType ? { grantType: input.meta.grantType } : {}),
            ...(bytesServed !== null ? { bytesServed } : {}),
            ...(referrerHost ? { referrerHost } : {}),
          },
          bytes: bytesServed ?? undefined,
        });

        // Roll bytes into the daily usage doc when we know the size.
        if (this.usageBus && bytesServed !== null && bytesServed > 0) {
          const eventId = `share.view/${input.linkId}/${viewedAt}/${ipHash.slice(0, 12)}`;
          void this.usageBus
            .publish({
              tenantId,
              counter: 'shareEgressBytes',
              value: bytesServed,
              occurredAt: viewedAt,
              eventId,
              meta: { linkId: input.linkId, source: 'share.viewed' },
            })
            .catch((err) => {
              logger.warn(
                { err, linkId: input.linkId, tenantId },
                'ShareViewTracker: usageBus.publish failed'
              );
            });
        }
      }
      return result;
    } catch (err) {
      logger.warn(
        { err, linkId: input.linkId, tenantId: input.tenantId },
        'ShareViewTracker.record failed'
      );
      return null;
    }
  }
}
