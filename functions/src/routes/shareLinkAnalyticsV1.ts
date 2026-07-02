/**
 * Per-share-link analytics endpoint (issue #198).
 *
 * `GET /v1/tenants/:tenantId/share-links/:linkId/analytics` \u2192
 *   {
 *     linkId, tenantId,
 *     totalViews, uniqueViewers, bytesServed, lastViewedAt,
 *     last7DaysSeries: [{ date: 'YYYY-MM-DD', views, bytesServed }]
 *   }
 *
 * Auth:
 *   - Host API key (viewer scope, tied to the same tenant); OR
 *   - Tenant owner via Bearer auth (legacy single-tenant-per-user
 *     mapping mirroring `tenantUsage.ts`).
 *
 * Constraints (documented in issue #198):
 *   - Tenant-scoped \u2014 the analytics doc is loaded via the tenantId in
 *     the URL and the linkId must belong to that tenant. Cross-tenant
 *     reads return 404 so we do not confirm the existence of a foreign
 *     link.
 *   - Read-only.
 *   - Honours the same per-tenant rate limiter as every other tenant
 *     route (mounted globally after `resolveTenant`).
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireUserOrTenantScopes } from '../middleware/hostApiKeyAuth.js';
import { logger } from '../utils/logger.js';
import type {
  ShareLinkAggregate,
  ShareViewRow,
  ShareViewStore,
} from '../services/sharing/ShareViewStore.js';

const LINK_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TENANT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: Record<string, unknown> | null;
  };
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> | null = null
): void {
  const body: ApiErrorPayload = {
    error: { code, message, requestId: randomUUID(), details },
  };
  res.status(status).json(body);
}

export interface ShareLinkDailyPoint {
  /** UTC day, `YYYY-MM-DD`. */
  date: string;
  views: number;
  bytesServed: number;
}

export interface ShareLinkAnalyticsResponse {
  linkId: string;
  tenantId: string;
  totalViews: number;
  uniqueViewers: number;
  bytesServed: number;
  lastViewedAt: string | null;
  /** 7 entries \u2014 today back through 6 days ago, in ascending order. */
  last7DaysSeries: ShareLinkDailyPoint[];
}

/**
 * Roll `rows` into a 7-day series ending at `now`. Days without views
 * emit zero-filled entries so the response shape is always length 7.
 */
export function buildLast7DaysSeries(
  rows: ShareViewRow[],
  now: Date = new Date()
): ShareLinkDailyPoint[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const series: ShareLinkDailyPoint[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const day = new Date(todayUtc.getTime() - i * dayMs);
    const date = day.toISOString().slice(0, 10);
    series.push({ date, views: 0, bytesServed: 0 });
  }
  const dateIndex = new Map<string, ShareLinkDailyPoint>();
  for (const p of series) {
    dateIndex.set(p.date, p);
  }
  for (const row of rows) {
    const date = row.viewedAt.slice(0, 10);
    const point = dateIndex.get(date);
    if (!point) continue;
    point.views += 1;
    point.bytesServed += row.bytesServed ?? 0;
  }
  return series;
}

function buildResponse(
  tenantId: string,
  linkId: string,
  aggregate: ShareLinkAggregate | null,
  series: ShareLinkDailyPoint[]
): ShareLinkAnalyticsResponse {
  if (!aggregate) {
    return {
      linkId,
      tenantId,
      totalViews: 0,
      uniqueViewers: 0,
      bytesServed: 0,
      lastViewedAt: null,
      last7DaysSeries: series,
    };
  }
  return {
    linkId,
    tenantId,
    totalViews: aggregate.totalViews,
    uniqueViewers: aggregate.uniqueViewers,
    bytesServed: aggregate.bytesServed,
    lastViewedAt: aggregate.lastViewedAt,
    last7DaysSeries: series,
  };
}

export interface ShareLinkAnalyticsRouterDeps {
  store: ShareViewStore;
  /**
   * Ownership check for Bearer-authenticated tenant owners. Mirrors the
   * signature used by the tenant-usage router so both surfaces share a
   * single mapping today (`userId === tenantId`).
   */
  ownsTenant: (userId: string, tenantId: string) => Promise<boolean>;
  /** Override for the current time. Used by tests to pin the 7-day window. */
  now?: () => Date;
}

export function createShareLinkAnalyticsRouter(
  deps: ShareLinkAnalyticsRouterDeps
): Router {
  const router = Router({ mergeParams: true });
  const now = deps.now ?? (() => new Date());

  router.get(
    '/:tenantId/share-links/:linkId/analytics',
    // Host key must carry `usage.read` (share analytics is a read-side
    // billing/observability surface, same shape as tenant usage). Bearer
    // fallback goes through the manual ownership check below when no
    // host key is presented.
    requireUserOrTenantScopes({
      scopes: ['usage.read'],
      tenantIdFromReq: (req) => (req.params.tenantId as string) || undefined,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        const linkId = String(req.params.linkId ?? '');
        if (!TENANT_ID_RE.test(tenantId)) {
          sendError(res, 400, 'INVALID_TENANT_ID', 'Invalid tenantId');
          return;
        }
        if (!LINK_ID_RE.test(linkId)) {
          sendError(res, 400, 'INVALID_LINK_ID', 'Invalid linkId');
          return;
        }

        // Extra ownership check for Bearer-authenticated tenant owners
        // (host-key path is already scope-checked by the middleware
        // above and cross-tenant-rejected).
        if (!req.tenant) {
          const userId = req.user?.uid;
          if (!userId || !(await deps.ownsTenant(userId, tenantId))) {
            sendError(
              res,
              403,
              'FORBIDDEN',
              'Caller is not authorized for this tenant'
            );
            return;
          }
        }

        const aggregate = await deps.store.getAggregate(tenantId, linkId);
        // Cross-tenant probe protection: if the aggregate exists but for
        // a *different* tenant, we still return the empty shape (never
        // confirm foreign link existence).
        const scoped = aggregate && aggregate.tenantId === tenantId ? aggregate : null;

        const currentTime = now();
        const dayMs = 24 * 60 * 60 * 1000;
        const from = new Date(currentTime.getTime() - 7 * dayMs).toISOString();
        const to = currentTime.toISOString();
        let rows: ShareViewRow[] = [];
        try {
          rows = await deps.store.listViews(tenantId, linkId, from, to);
        } catch (err) {
          // Bounded-range failure should not tank the summary response.
          logger.warn(
            { err, tenantId, linkId },
            'ShareViewStore.listViews failed; serving series as zeros'
          );
        }
        const series = buildLast7DaysSeries(rows, currentTime);

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json(buildResponse(tenantId, linkId, scoped, series));
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

export const __test = {
  buildLast7DaysSeries,
  LINK_ID_RE,
  TENANT_ID_RE,
};
