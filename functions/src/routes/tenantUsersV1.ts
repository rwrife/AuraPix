/**
 * Tenant user (membership) management.
 *
 * Four endpoints intentionally kept minimal for the initial release
 * (see issue #143):
 *
 *   POST   /v1/tenants/:tenantId/users            — provision a user
 *   GET    /v1/tenants/:tenantId/users            — list memberships
 *   PATCH  /v1/tenants/:tenantId/users/:userId    — change role
 *   DELETE /v1/tenants/:tenantId/users/:userId    — revoke membership
 *
 * Auth: host API key with `tenants:write` scope (or `tenants.read` for GET).
 * Cross-tenant access returns 404 (not 403) so the existence of memberships
 * in other tenants is never leaked.
 *
 * Metering signals (see docs/features/metering-events.md):
 *   - `user.provisioned`   on POST (newly created membership)
 *   - `user.revoked`       on DELETE
 *   - `user.active`        at most once per (tenantId, userId, UTC day)
 *                          from the request-scoped middleware
 *
 * The host owns the invite UX — POST creates a membership record but does
 * NOT send any email.
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { MeteringBus } from '../services/metering/MeteringBus.js';
import {
  createMembership,
  getMembership,
  listMemberships,
  revokeMembership,
  touchLastActive,
  updateMembership,
  UserActiveDebouncer,
} from '../services/tenant/tenantMembershipService.js';
import {
  isTenantMemberRole,
  type TenantMemberRecord,
  type TenantMemberRole,
} from '../models/TenantMember.js';
import type { TenantApiKeyScope } from '../models/TenantApiKey.js';
import { logger } from '../utils/logger.js';

export interface TenantUsersRouterDeps {
  dataAdapter: DataAdapter;
  meteringBus?: Pick<MeteringBus, 'emit'>;
  /** Override for tests; defaults to a fresh in-memory debouncer. */
  userActiveDebouncer?: UserActiveDebouncer;
}

interface MembershipView {
  userId: string;
  tenantId: string;
  email: string;
  role: TenantMemberRole;
  createdAt: string;
  lastActiveAt: string | null;
}

function toView(record: TenantMemberRecord): MembershipView {
  return {
    userId: record.userId,
    tenantId: record.tenantId,
    email: record.email,
    role: record.role,
    createdAt: record.createdAt,
    lastActiveAt: record.lastActiveAt,
  };
}

function sendNotFound(res: Response): void {
  // Cross-tenant attempts ALSO land here (the membership exists in another
  // tenant but is invisible to this caller) — by returning 404 we avoid
  // leaking the existence of the resource.
  res.status(404).json({ error: 'Membership not found' });
}

/**
 * Require the caller to be a host API key authenticated for the tenant in
 * the URL with the given scope.
 *
 * NOTE: Cross-tenant key calls return 404 (NOT 403) per the issue's
 * "do not leak existence" requirement. Missing scope returns 403. Missing
 * auth returns 401.
 */
function requireTenantScope(scope: TenantApiKeyScope) {
  return function guard(req: Request, res: Response, next: NextFunction): void {
    if (!req.tenant) {
      res.status(401).json({ error: 'Host API key required' });
      return;
    }
    const urlTenantId = String(req.params.tenantId ?? '');
    if (urlTenantId && req.tenant.id !== urlTenantId) {
      // Cross-tenant — return 404 to avoid leaking existence.
      sendNotFound(res);
      return;
    }
    if (!req.tenant.scopes.includes(scope)) {
      res.status(403).json({ error: 'Insufficient scope', missing: [scope] });
      return;
    }
    next();
  };
}

/**
 * Express middleware factory: on each authenticated request that targets a
 * tenant, emit `user.active` at most once per (tenantId, userId, UTC day).
 *
 * Mounted by the route layer so it only fires for tenant-scoped requests.
 */
export function createUserActivityTracker(deps: {
  dataAdapter: DataAdapter;
  meteringBus?: Pick<MeteringBus, 'emit'>;
  debouncer: UserActiveDebouncer;
}) {
  return function tracker(req: Request, _res: Response, next: NextFunction): void {
    const tenantId = req.tenant?.id ?? String(req.params.tenantId ?? '');
    const userId = req.user?.uid;
    if (tenantId && userId) {
      const now = new Date().toISOString();
      if (deps.debouncer.shouldEmit(tenantId, userId, now)) {
        try {
          deps.meteringBus?.emit({
            tenantId,
            type: 'user.active',
            resourceId: userId,
            occurredAt: now,
          });
        } catch (err) {
          logger.debug({ err }, 'user.active emit failed');
        }
        // Best-effort touch on the membership row.
        void touchLastActive(deps.dataAdapter, tenantId, userId, now);
      }
    }
    next();
  };
}

export function createTenantUsersRouter(deps: TenantUsersRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const debouncer = deps.userActiveDebouncer ?? new UserActiveDebouncer();

  // Activity tracker fires for every tenant-scoped request handled here.
  // (For routes that need it on the whole API surface, mount the same
  //  factory at a higher level in server.ts.)
  router.use(
    createUserActivityTracker({
      dataAdapter: deps.dataAdapter,
      meteringBus: deps.meteringBus,
      debouncer,
    })
  );

  // POST /v1/tenants/:tenantId/users
  router.post(
    '/:tenantId/users',
    requireTenantScope('tenants:write'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const body = (req.body ?? {}) as {
          email?: unknown;
          userId?: unknown;
          role?: unknown;
        };
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        const role = body.role;
        if (!email || !email.includes('@')) {
          res.status(400).json({ error: 'email is required' });
          return;
        }
        if (!isTenantMemberRole(role)) {
          res
            .status(400)
            .json({ error: "role must be one of 'owner' | 'editor' | 'viewer'" });
          return;
        }
        // The host can pass an explicit userId (e.g. their own user id system).
        // If absent, fall back to the email itself as the stable id. Hosts that
        // want collision-free ids should always pass userId.
        const userId =
          typeof body.userId === 'string' && body.userId.trim().length > 0
            ? body.userId.trim()
            : email;

        const { record, created } = await createMembership(deps.dataAdapter, {
          tenantId,
          userId,
          email,
          role,
        });

        if (created) {
          deps.meteringBus?.emit({
            tenantId,
            type: 'user.provisioned',
            resourceId: userId,
            meta: { role, email },
          });
        }
        res.status(created ? 201 : 200).json({ user: toView(record) });
      } catch (err) {
        next(err);
      }
    }
  );

  // GET /v1/tenants/:tenantId/users
  router.get(
    '/:tenantId/users',
    requireTenantScope('tenants.read'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const members = await listMemberships(deps.dataAdapter, tenantId);
        res.json({ users: members.map(toView), nextPageToken: null });
      } catch (err) {
        next(err);
      }
    }
  );

  // PATCH /v1/tenants/:tenantId/users/:userId
  router.patch(
    '/:tenantId/users/:userId',
    requireTenantScope('tenants:write'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const userId = String(req.params.userId);
        const body = (req.body ?? {}) as { role?: unknown };
        if (body.role !== undefined && !isTenantMemberRole(body.role)) {
          res
            .status(400)
            .json({ error: "role must be one of 'owner' | 'editor' | 'viewer'" });
          return;
        }
        const updated = await updateMembership(deps.dataAdapter, tenantId, userId, {
          role: body.role as TenantMemberRole | undefined,
        });
        if (!updated) {
          sendNotFound(res);
          return;
        }
        res.json({ user: toView(updated) });
      } catch (err) {
        next(err);
      }
    }
  );

  // DELETE /v1/tenants/:tenantId/users/:userId
  router.delete(
    '/:tenantId/users/:userId',
    requireTenantScope('tenants:write'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const userId = String(req.params.userId);
        const existing = await getMembership(deps.dataAdapter, tenantId, userId);
        if (!existing) {
          sendNotFound(res);
          return;
        }
        const revoked = await revokeMembership(deps.dataAdapter, tenantId, userId);
        if (!revoked) {
          sendNotFound(res);
          return;
        }
        deps.meteringBus?.emit({
          tenantId,
          type: 'user.revoked',
          resourceId: userId,
          meta: { role: existing.role },
        });
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
