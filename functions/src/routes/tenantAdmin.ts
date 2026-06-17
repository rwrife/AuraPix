/**
 * PATCH /api/v1/tenants/:tenantId
 *
 * Host-key authenticated administrative endpoint to update tenant
 * configuration. Today only `quotaBytes` is mutable. Auth: a host API key
 * carrying the `tenants.write` scope, whose tenantId matches the path
 * parameter (cross-tenant patches return 403).
 *
 * See issue #139 for the in-process storage quota enforcement that reads
 * the value persisted here.
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { requireUserOrTenantScopes } from '../middleware/hostApiKeyAuth.js';
import {
  patchTenantRecord,
  getTenantRecord,
  validateQuotaBytesInput,
} from '../services/tenant/tenantRecordService.js';
import { isValidTenantId } from '../domain/tenant/Tenant.js';
import { logger } from '../utils/logger.js';

export function createTenantAdminRouter(dataAdapter: DataAdapter): Router {
  const router = Router({ mergeParams: true });

  router.patch(
    '/:tenantId',
    requireUserOrTenantScopes({
      scopes: ['tenants.write'],
      tenantIdFromReq: (req) => (req.params.tenantId as string) || undefined,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        if (!isValidTenantId(tenantId)) {
          res.status(400).json({
            error: 'Invalid tenantId',
            code: 'INVALID_TENANT_ID',
          });
          return;
        }
        const body = (req.body || {}) as { quotaBytes?: unknown };
        const patch: { quotaBytes?: number | null } = {};
        if ('quotaBytes' in body) {
          try {
            patch.quotaBytes = validateQuotaBytesInput(body.quotaBytes);
          } catch (err) {
            res.status(400).json({
              error:
                err instanceof Error ? err.message : 'Invalid quotaBytes',
              code: 'INVALID_QUOTA_BYTES',
            });
            return;
          }
        }
        const updated = await patchTenantRecord(dataAdapter, tenantId, patch);
        res.json({ tenant: updated });
      } catch (err) {
        logger.error({ err }, 'Tenant PATCH failed');
        next(err);
      }
    }
  );

  router.get(
    '/:tenantId',
    requireUserOrTenantScopes({
      scopes: ['tenants.read'],
      tenantIdFromReq: (req) => (req.params.tenantId as string) || undefined,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        if (!isValidTenantId(tenantId)) {
          res.status(400).json({
            error: 'Invalid tenantId',
            code: 'INVALID_TENANT_ID',
          });
          return;
        }
        const record = await getTenantRecord(dataAdapter, tenantId);
        res.json({ tenant: record });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
