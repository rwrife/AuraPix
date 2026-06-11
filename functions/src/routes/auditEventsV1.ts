/**
 * Host audit events API (issue #164).
 *
 *   GET /v1/tenants/:tenantId/audit-events
 *
 * Read-only paginated access to recent audit entries written by
 * `AuditService.recordAuditEvent` (sharing, bulk delete, role changes,
 * key rotation, etc.). Intended for host applications reselling AuraPix
 * who want to surface an activity log in their own admin UI without
 * standing up an event store.
 *
 * Auth: host API key with the `audit.read` scope (or a Bearer user who
 * owns the tenant — kept for parity with `tenantUsage`/`webhookDeliveries`).
 *
 * Pagination: opaque `pageToken` cursor; stable ordering
 * (occurredAt desc, id desc).
 *
 * Retention: hard cap of 90 days; older entries are excluded.
 *
 * Cross-tenant access is rejected with 403 via
 * `requireUserOrTenantScopes`.
 *
 * Metering: each call publishes `audit.queried`
 *   `{ tenantId, pageSize, filterKeys }`
 * to the MeteringBus when one is wired on `app.locals.meteringBus`, and
 * increments the `apiCalls` counter on the UsageMeteringBus so the host
 * billing rollups stay accurate.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import {
  requireUserOrTenantScopes,
} from '../middleware/hostApiKeyAuth.js';
import {
  AUDIT_RETENTION_DAYS,
  queryAuditEvents,
  type AuditEventRecord,
} from '../services/audit/AuditService.js';
import type { MeteringBus } from '../services/metering/MeteringBus.js';
import type { UsageMeteringBus } from '../services/metering/UsageMeteringBus.js';

export interface AuditEventsRouterDeps {
  dataAdapter: DataAdapter;
  /**
   * Optional metering bus for emitting the canonical `audit.queried`
   * event. When omitted, calls are still served but no event is fired —
   * matches the pattern other routes use during local-dev wiring.
   */
  meteringBus?: MeteringBus;
  /**
   * Optional usage bus used to bump the per-tenant `apiCalls` counter so
   * existing `api.call` rollups remain accurate.
   */
  usageBus?: UsageMeteringBus;
  /**
   * Optional ownership check for Bearer-authenticated users. Defaults to a
   * deny-all (host-key-only) policy.
   */
  ownsTenant?: (userId: string, tenantId: string) => Promise<boolean>;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

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

function parsePageSize(raw: unknown): number | { error: string } {
  if (raw === undefined || raw === '') return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { error: 'pageSize must be a positive integer' };
  }
  if (n > MAX_PAGE_SIZE) {
    return { error: `pageSize must be <= ${MAX_PAGE_SIZE}` };
  }
  return n;
}

function isValidIsoTimestamp(value: string): boolean {
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

/**
 * Shape audit records into the public API contract. Internal field names
 * (`eventType`, `actorId`, `targetId`, `createdAt`) are mapped to the
 * documented `action`, `actor`, `resourceId`, `occurredAt` names so the
 * stored shape can evolve without breaking the contract.
 */
function toPublic(record: AuditEventRecord): {
  id: string;
  occurredAt: string;
  actor: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
} {
  return {
    id: record.id,
    occurredAt: record.occurredAt ?? record.createdAt,
    actor: record.actorId,
    action: record.eventType,
    resourceType: record.resourceType ?? null,
    resourceId: record.targetId ?? null,
    metadata: record.metadata ?? null,
  };
}

export function createAuditEventsV1Router(deps: AuditEventsRouterDeps): Router {
  const router = Router({ mergeParams: true });

  const tenantFromParams = (req: Request): string | undefined =>
    req.params.tenantId ? String(req.params.tenantId) : undefined;

  const scopeGuard = requireUserOrTenantScopes({
    scopes: ['audit.read'],
    tenantIdFromReq: tenantFromParams,
  });

  router.get(
    '/:tenantId/audit-events',
    // Extra owner check happens inside the handler (host-key path is fully
    // covered by `scopeGuard`; the Bearer-user path needs ownsTenant).
    scopeGuard,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        if (!tenantId) {
          sendError(res, 400, 'VALIDATION_ERROR', 'tenantId is required');
          return;
        }

        // If authenticated via Bearer user (not host key), require explicit
        // ownership. Host-key requests are already tenant-bound by
        // `requireUserOrTenantScopes`.
        if (!req.tenant && req.user) {
          const owns = deps.ownsTenant
            ? await deps.ownsTenant(req.user.uid, tenantId)
            : false;
          if (!owns) {
            sendError(
              res,
              403,
              'FORBIDDEN',
              'Caller is not authorized for this tenant'
            );
            return;
          }
        }

        const since = req.query.since ? String(req.query.since) : undefined;
        const until = req.query.until ? String(req.query.until) : undefined;
        const actorId = req.query.actorId
          ? String(req.query.actorId)
          : undefined;
        const action = req.query.action ? String(req.query.action) : undefined;
        const resourceType = req.query.resourceType
          ? String(req.query.resourceType)
          : undefined;
        const pageToken = req.query.pageToken
          ? String(req.query.pageToken)
          : undefined;

        if (since && !isValidIsoTimestamp(since)) {
          sendError(
            res,
            400,
            'VALIDATION_ERROR',
            'since must be an ISO-8601 timestamp',
            { since }
          );
          return;
        }
        if (until && !isValidIsoTimestamp(until)) {
          sendError(
            res,
            400,
            'VALIDATION_ERROR',
            'until must be an ISO-8601 timestamp',
            { until }
          );
          return;
        }
        if (since && until && since > until) {
          sendError(
            res,
            400,
            'VALIDATION_ERROR',
            'since must be on or before until',
            { since, until }
          );
          return;
        }

        const pageSize = parsePageSize(req.query.pageSize);
        if (typeof pageSize === 'object') {
          sendError(res, 400, 'VALIDATION_ERROR', pageSize.error, {
            pageSize: req.query.pageSize,
          });
          return;
        }

        const page = await queryAuditEvents(deps.dataAdapter, {
          tenantId,
          since,
          until,
          actorId,
          action,
          resourceType,
          pageSize,
          pageToken,
        });

        const filterKeys: string[] = [];
        if (since) filterKeys.push('since');
        if (until) filterKeys.push('until');
        if (actorId) filterKeys.push('actorId');
        if (action) filterKeys.push('action');
        if (resourceType) filterKeys.push('resourceType');

        // Metering: best-effort, fire-and-forget. Never block the response.
        try {
          deps.meteringBus?.emit({
            tenantId,
            type: 'audit.queried',
            meta: { pageSize, filterKeys },
          });
        } catch {
          /* swallow */
        }
        try {
          await deps.usageBus?.publish({
            tenantId,
            counter: 'apiCalls',
            value: 1,
            occurredAt: new Date().toISOString(),
          });
        } catch {
          /* swallow */
        }

        res.json({
          tenantId,
          events: page.events.map(toPublic),
          nextPageToken: page.nextPageToken,
          retentionDays: AUDIT_RETENTION_DAYS,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

export const __test = {
  parsePageSize,
  isValidIsoTimestamp,
  toPublic,
};
