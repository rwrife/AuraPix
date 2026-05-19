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
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type {
  DailyDocStore,
  UsageDailyDoc,
} from '../services/metering/UsageRollupConsumer.js';
import { emptyDailyDoc } from '../services/metering/UsageRollupConsumer.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 100;

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

export function createTenantUsageRouter(deps: UsageRouterDeps): Router {
  const router = Router({ mergeParams: true });

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
};
