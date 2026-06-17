/**
 * Tenant offboarding routes (issue #155).
 *
 *  POST   /api/v1/tenants/:tenantId/export
 *  GET    /api/v1/tenants/:tenantId/exports/:exportId
 *  DELETE /api/v1/tenants/:tenantId
 *
 * Auth: host API key only \u2014 these are operational decisions made by
 * the host application, not by end-users. Bearer (Firebase) auth is
 * explicitly rejected even when the user owns the tenant.
 *
 * The DELETE endpoint additionally requires an `X-Confirm-Tenant-Id`
 * header matching the path id; mismatched header returns 400.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { TenantOffboardingService } from '../services/tenant/TenantOffboardingService.js';

export interface TenantOffboardingRouterDeps {
  service: TenantOffboardingService;
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

/**
 * Reject any request not authenticated by a host API key carrying
 * the `tenant.admin` scope for the path tenant. This is intentionally
 * stricter than `requireUserOrTenantScopes` because offboarding must
 * never be initiated by an end-user bearer token.
 */
function requireHostKeyAdmin(req: Request, res: Response): boolean {
  const tenantId = String(req.params.tenantId ?? '');
  if (!tenantId) {
    sendError(res, 400, 'VALIDATION_ERROR', 'tenantId is required');
    return false;
  }
  if (!req.tenant) {
    sendError(
      res,
      401,
      'HOST_KEY_REQUIRED',
      'This endpoint requires a host API key (Authorization: Bearer ak_live_...)'
    );
    return false;
  }
  if (req.tenant.id !== tenantId) {
    sendError(res, 403, 'FORBIDDEN', 'Cross-tenant request rejected');
    return false;
  }
  if (!req.tenant.scopes.includes('tenant.admin')) {
    sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Missing required scope', {
      missing: ['tenant.admin'],
    });
    return false;
  }
  return true;
}

export function createTenantOffboardingRouter(
  deps: TenantOffboardingRouterDeps
): Router {
  const router = Router({ mergeParams: true });
  const { service } = deps;

  // POST /:tenantId/export
  router.post(
    '/:tenantId/export',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!requireHostKeyAdmin(req, res)) return;
        const tenantId = String(req.params.tenantId);
        const record = await service.requestExport(tenantId);
        res.status(202).json({
          exportId: record.id,
          status: record.status,
          createdAt: record.createdAt,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // GET /:tenantId/exports/:exportId
  router.get(
    '/:tenantId/exports/:exportId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!requireHostKeyAdmin(req, res)) return;
        const tenantId = String(req.params.tenantId);
        const exportId = String(req.params.exportId ?? '');
        if (!exportId) {
          sendError(res, 400, 'VALIDATION_ERROR', 'exportId is required');
          return;
        }
        const record = await service.getExport(tenantId, exportId);
        if (!record) {
          sendError(res, 404, 'NOT_FOUND', 'Export not found');
          return;
        }
        res.json({
          exportId: record.id,
          status: record.status,
          createdAt: record.createdAt,
          completedAt: record.completedAt,
          bytes: record.bytes,
          manifestSha256: record.manifestSha256 ?? null,
          downloadUrl: record.downloadUrl ?? null,
          downloadUrlExpiresAt: record.downloadUrlExpiresAt ?? null,
          error: record.error ?? null,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // DELETE /:tenantId
  router.delete(
    '/:tenantId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!requireHostKeyAdmin(req, res)) return;
        const tenantId = String(req.params.tenantId);
        const confirm = String(req.header('x-confirm-tenant-id') ?? '');
        if (confirm !== tenantId) {
          sendError(
            res,
            400,
            'CONFIRMATION_REQUIRED',
            'X-Confirm-Tenant-Id header must match path tenantId',
            { expected: tenantId, received: confirm || null }
          );
          return;
        }
        const progress = await service.deleteTenant(tenantId);
        res.status(200).json({
          tenantId,
          completedAt: progress.completedAt,
          itemsDeleted: progress.itemsDeleted,
          bytesFreed: progress.bytesFreed,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
