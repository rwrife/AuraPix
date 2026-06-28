/**
 * GET /api/v1/tenants/:tenantId/usage
 *
 * Returns the per-tenant daily usage rollup docs across a bounded date range.
 * This is the canonical billing pull surface (issue #133).
 *
 * Auth: tenant owner (via Bearer auth) OR a host API key with the
 * `usage.read` scope. Host API keys land in their own issue; until then the
 * route honours an optional `hostScopeChecker` injected at construction time.
 *
 * Constraints:
 *   - from/to are required, YYYY-MM-DD
 *   - max range: 100 days (inclusive)
 *   - cross-tenant access returns 403
 *
 * Response negotiation (issue #186):
 *   - Default: JSON (`application/json`).
 *   - CSV: returned when `Accept: text/csv` is sent OR `?format=csv` is
 *     present. CSV rows mirror the JSON `items` in a documented, locked
 *     column order (see `CSV_COLUMNS` below and
 *     `docs/features/usage-and-billing.md`). The CSV body is streamed
 *     (chunked transfer) so we never buffer the full range in memory.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type {
  DailyDocStore,
  UsageDailyDoc,
} from '../services/metering/UsageRollupConsumer.js';
import { emptyDailyDoc } from '../services/metering/UsageRollupConsumer.js';
import type { DistinctActiveUsersQuery } from '../services/metering/UserActiveDailyStore.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 100;
const CURRENT_CACHE_TTL_MS = 60_000;

/**
 * Locked column order for the CSV variant. This is part of the public
 * billing contract — never reorder, rename, or insert columns in the
 * middle; only append new columns at the end, and only after coordinating
 * with the docs (`docs/features/usage-and-billing.md`) and the OpenAPI
 * response example.
 *
 * `appliedEventIds` (idempotency bookkeeping on `UsageDailyDoc`) is
 * intentionally excluded — it is not a billing field.
 */
export const CSV_COLUMNS = [
  'tenantId',
  'date',
  'storageBytesDelta',
  'imagesUploaded',
  'imagesProcessed',
  'signedUrlsIssued',
  'editsApplied',
  'tagsApplied',
  'apiCalls',
  'exportBytes',
  'activeUsers',
  'rateLimited',
  'storageBytesTotal',
  'updatedAt',
] as const satisfies ReadonlyArray<keyof UsageDailyDoc>;

type CsvColumn = (typeof CSV_COLUMNS)[number];

/**
 * Render a single CSV cell. Per RFC 4180:
 *   - Fields containing `,`, `"`, CR, or LF are wrapped in double quotes.
 *   - Embedded `"` is escaped as `""`.
 * `null` is rendered as an empty cell (used by `storageBytesTotal` until
 * the daily snapshot lands).
 */
function renderCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function renderCsvRow(doc: UsageDailyDoc): string {
  const cells: string[] = [];
  for (const col of CSV_COLUMNS) {
    cells.push(renderCsvCell(doc[col as CsvColumn]));
  }
  return cells.join(',');
}

function wantsCsv(req: Request): boolean {
  const fmt = String(req.query.format ?? '').toLowerCase();
  if (fmt === 'csv') return true;
  const accept = String(req.headers['accept'] ?? '').toLowerCase();
  if (!accept) return false;
  // We only honour an explicit text/csv preference. Wildcards (`*/*`) fall
  // back to JSON to preserve the existing default for tools that don't set
  // an Accept header explicitly.
  return accept.split(',').some((part) => part.trim().startsWith('text/csv'));
}

export type TenantOwnershipChecker = (
  userId: string,
  tenantId: string
) => Promise<boolean>;

export type HostScopeChecker = (
  req: Request,
  tenantId: string,
  scope: 'usage.read'
) => Promise<boolean>;

export interface UsageRouterDeps {
  store: DailyDocStore & {
    /**
     * Optional bulk read for a tenant; if absent the router falls back to
     * iterating dates via the store's transact() read step.
     */
    listRange?: (
      tenantId: string,
      from: string,
      to: string
    ) => Promise<UsageDailyDoc[]>;
  };
  ownsTenant: TenantOwnershipChecker;
  hostScopeChecker?: HostScopeChecker;
  /**
   * Optional source-of-truth lookup for distinct `activeUsers` across a
   * date range (issue #188). When provided, the month-to-date summary
   * endpoint uses it to de-duplicate users seen on multiple days; when
   * omitted, the endpoint falls back to summing per-day `activeUsers`
   * (a conservative upper bound) and documents the eventual-consistency
   * window.
   */
  distinctActiveUsers?: DistinctActiveUsersQuery;
  /**
   * Override for the current time. Used by tests to pin the UTC month
   * window; production code omits this and gets `new Date()`.
   */
  now?: () => Date;
}

interface ErrorBody {
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
  const body: ErrorBody = {
    error: { code, message, requestId: randomUUID(), details },
  };
  res.status(status).json(body);
}

function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Round-trip check to reject e.g. 2024-02-30.
  if (d.toISOString().slice(0, 10) !== value) return null;
  return d;
}

function daysBetweenInclusive(from: Date, to: Date): number {
  const diff = to.getTime() - from.getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000)) + 1;
}

function eachDate(from: Date, to: Date): string[] {
  const out: string[] = [];
  const d = new Date(from);
  while (d.getTime() <= to.getTime()) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Subset of `UsageDailyDoc` that is meaningful to sum across days. These
 * are the counters that accumulate over time; `appliedEventIds` (idempotency
 * bookkeeping), `updatedAt`, `storageBytesTotal` (point-in-time snapshot),
 * `tenantId`, and `date` are deliberately excluded.
 */
export const SUMMABLE_COUNTERS = [
  'storageBytesDelta',
  'imagesUploaded',
  'imagesProcessed',
  'signedUrlsIssued',
  'editsApplied',
  'tagsApplied',
  'apiCalls',
  'exportBytes',
  'activeUsers',
  'rateLimited',
] as const satisfies ReadonlyArray<keyof UsageDailyDoc>;

type SummableCounter = (typeof SUMMABLE_COUNTERS)[number];

export type UsageCurrentTotals = Record<SummableCounter, number>;

/**
 * Response body for `GET /v1/tenants/:id/usage/current` (issue #188). Wraps
 * the summable counters of `UsageDailyDoc` with the period window and the
 * snapshot timestamp. `activeUsers` is the distinct user count for the
 * period when a `DistinctActiveUsersQuery` is wired, otherwise the
 * sum-of-daily-distincts (documented eventual-consistency window).
 */
export interface TenantUsageCurrentResponse extends UsageCurrentTotals {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
}

/**
 * Compute the current UTC month window for `now`. `periodStart` is the
 * first day of the month; `periodEnd` is `now`'s UTC day. Both are
 * YYYY-MM-DD strings. This is what "month-to-date" means in #188 — we do
 * not look ahead to days that have not happened yet.
 */
export function currentUtcMonthRange(now: Date): {
  periodStart: string;
  periodEnd: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  const periodStart = `${year}-${pad(month + 1)}-01`;
  const periodEnd = `${year}-${pad(month + 1)}-${pad(day)}`;
  return { periodStart, periodEnd };
}

/**
 * Sum the `SUMMABLE_COUNTERS` columns across `docs`. Returns zero-filled
 * totals when `docs` is empty (i.e. tenants with no activity this month
 * get a valid response, not a 404).
 */
export function sumCounters(docs: UsageDailyDoc[]): UsageCurrentTotals {
  const totals: UsageCurrentTotals = {
    storageBytesDelta: 0,
    imagesUploaded: 0,
    imagesProcessed: 0,
    signedUrlsIssued: 0,
    editsApplied: 0,
    tagsApplied: 0,
    apiCalls: 0,
    exportBytes: 0,
    activeUsers: 0,
    rateLimited: 0,
  };
  for (const doc of docs) {
    for (const c of SUMMABLE_COUNTERS) {
      totals[c] += doc[c];
    }
  }
  return totals;
}

export function createTenantUsageRouter(deps: UsageRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const now = deps.now ?? (() => new Date());

  /**
   * In-memory month-to-date cache, keyed by `tenantId::periodStart`.
   * Entries auto-evict on read once they exceed `CURRENT_CACHE_TTL_MS`,
   * and the entry for a tenant is invalidated explicitly when the
   * underlying `usageDaily` rollup is mutated through this process. See
   * `invalidateTenant` below — it is also exposed via `app.locals` so
   * the rollup consumer can notify after a write.
   *
   * Note: in a multi-process deployment the eventual-consistency window
   * is bounded by the 60s TTL; hosts that need stricter freshness should
   * cache-bust on their side.
   */
  const currentCache = new Map<
    string,
    { expiresAt: number; payload: TenantUsageCurrentResponse }
  >();

  function cacheKey(tenantId: string, periodStart: string): string {
    return `${tenantId}::${periodStart}`;
  }

  function getCached(
    tenantId: string,
    periodStart: string
  ): TenantUsageCurrentResponse | null {
    const key = cacheKey(tenantId, periodStart);
    const entry = currentCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now().getTime()) {
      currentCache.delete(key);
      return null;
    }
    return entry.payload;
  }

  function setCached(
    tenantId: string,
    periodStart: string,
    payload: TenantUsageCurrentResponse
  ): void {
    currentCache.set(cacheKey(tenantId, periodStart), {
      expiresAt: now().getTime() + CURRENT_CACHE_TTL_MS,
      payload,
    });
  }

  /**
   * Invalidate every cached month-to-date summary for `tenantId`. Safe to
   * call from rollup write paths.
   */
  function invalidateTenant(tenantId: string): void {
    const prefix = `${tenantId}::`;
    for (const key of currentCache.keys()) {
      if (key.startsWith(prefix)) currentCache.delete(key);
    }
  }

  (router as Router & {
    invalidateTenantCurrentCache?: (tenantId: string) => void;
  }).invalidateTenantCurrentCache = invalidateTenant;

  router.get(
    '/:tenantId/usage/current',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        if (!tenantId) {
          sendError(res, 400, 'VALIDATION_ERROR', 'tenantId is required');
          return;
        }

        // Auth: owner OR host key scope (same model as /usage).
        const userId = req.user?.uid;
        let authorized = false;
        if (userId && (await deps.ownsTenant(userId, tenantId))) {
          authorized = true;
        } else if (
          deps.hostScopeChecker &&
          (await deps.hostScopeChecker(req, tenantId, 'usage.read'))
        ) {
          authorized = true;
        }
        if (!authorized) {
          sendError(
            res,
            403,
            'FORBIDDEN',
            'Caller is not authorized for this tenant'
          );
          return;
        }

        const currentTime = now();
        const period = currentUtcMonthRange(currentTime);
        const cached = getCached(tenantId, period.periodStart);
        if (cached) {
          res.setHeader('Cache-Control', 'private, max-age=60');
          res.setHeader('X-Cache', 'HIT');
          res.json(cached);
          return;
        }

        // Pull the existing daily docs for the month-to-date window. We
        // intentionally reuse the same store contract as `/usage` so the
        // summary is always consistent with the per-day view.
        let docs: UsageDailyDoc[];
        if (deps.store.listRange) {
          docs = await deps.store.listRange(
            tenantId,
            period.periodStart,
            period.periodEnd
          );
        } else {
          docs = [];
          for (const date of eachDate(
            new Date(`${period.periodStart}T00:00:00.000Z`),
            new Date(`${period.periodEnd}T00:00:00.000Z`)
          )) {
            const doc = await deps.store.transact(
              tenantId,
              date,
              (current) => current ?? emptyDailyDoc(tenantId, date)
            );
            docs.push(doc);
          }
        }

        const totals = sumCounters(docs);

        // De-dupe activeUsers across the month if the capability is wired,
        // otherwise fall back to the per-day sum already in `totals`.
        if (deps.distinctActiveUsers) {
          const distinct = await deps.distinctActiveUsers.listDistinctUsers(
            tenantId,
            period.periodStart,
            period.periodEnd
          );
          totals.activeUsers = distinct.length;
        }

        const payload: TenantUsageCurrentResponse = {
          tenantId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          generatedAt: currentTime.toISOString(),
          ...totals,
        };
        setCached(tenantId, period.periodStart, payload);

        res.setHeader('Cache-Control', 'private, max-age=60');
        res.setHeader('X-Cache', 'MISS');
        res.json(payload);
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/:tenantId/usage',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        if (!tenantId) {
          sendError(res, 400, 'VALIDATION_ERROR', 'tenantId is required');
          return;
        }

        const fromRaw = String(req.query.from ?? '');
        const toRaw = String(req.query.to ?? '');
        const from = parseIsoDate(fromRaw);
        const to = parseIsoDate(toRaw);
        if (!from || !to) {
          sendError(
            res,
            400,
            'VALIDATION_ERROR',
            'from and to are required and must be YYYY-MM-DD',
            { from: fromRaw, to: toRaw }
          );
          return;
        }
        if (from.getTime() > to.getTime()) {
          sendError(res, 400, 'VALIDATION_ERROR', 'from must be on or before to');
          return;
        }
        const days = daysBetweenInclusive(from, to);
        if (days > MAX_RANGE_DAYS) {
          sendError(
            res,
            400,
            'RANGE_TOO_LARGE',
            `Date range exceeds maximum of ${MAX_RANGE_DAYS} days`,
            { requestedDays: days, maxDays: MAX_RANGE_DAYS }
          );
          return;
        }

        // Auth: owner OR host key scope.
        const userId = req.user?.uid;
        let authorized = false;
        if (userId && (await deps.ownsTenant(userId, tenantId))) {
          authorized = true;
        } else if (
          deps.hostScopeChecker &&
          (await deps.hostScopeChecker(req, tenantId, 'usage.read'))
        ) {
          authorized = true;
        }
        if (!authorized) {
          sendError(
            res,
            403,
            'FORBIDDEN',
            'Caller is not authorized for this tenant'
          );
          return;
        }

        const dates = eachDate(from, to);
        let docs: UsageDailyDoc[];
        if (deps.store.listRange) {
          docs = await deps.store.listRange(tenantId, fromRaw, toRaw);
          const present = new Set(docs.map((d) => d.date));
          for (const date of dates) {
            if (!present.has(date)) {
              docs.push(emptyDailyDoc(tenantId, date));
            }
          }
        } else {
          docs = [];
          for (const date of dates) {
            // No-op transact: returns current or empty.
            const doc = await deps.store.transact(
              tenantId,
              date,
              (current) => current ?? emptyDailyDoc(tenantId, date)
            );
            docs.push(doc);
          }
        }
        docs.sort((a, b) => a.date.localeCompare(b.date));

        if (wantsCsv(req)) {
          // Stream the response. We deliberately set neither Content-Length
          // nor accumulate the full body into a string — Express/Node will
          // pick chunked transfer for HTTP/1.1, ensuring the response is
          // not buffered (verified in the integration test).
          res.status(200);
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="usage-${tenantId}-${fromRaw}-to-${toRaw}.csv"`
          );
          // Header row first.
          res.write(`${CSV_COLUMNS.join(',')}\n`);
          for (const doc of docs) {
            res.write(`${renderCsvRow(doc)}\n`);
          }
          res.end();
          return;
        }

        res.json({
          tenantId,
          from: fromRaw,
          to: toRaw,
          days,
          items: docs,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

export const __test = {
  parseIsoDate,
  daysBetweenInclusive,
  eachDate,
  MAX_RANGE_DAYS,
  CURRENT_CACHE_TTL_MS,
  renderCsvCell,
  renderCsvRow,
  wantsCsv,
  currentUtcMonthRange,
  sumCounters,
};
