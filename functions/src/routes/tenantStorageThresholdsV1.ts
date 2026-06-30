/**
 * Per-tenant storage threshold config endpoints (issue #196).
 *
 * Mounted at `/v1/tenants/:tenantId/storage/thresholds` (and the legacy
 * `/api/v1/tenants/...` alias). Both endpoints are host-API-key only
 * with the `tenants.write` scope (read uses `tenants.read`) and are
 * scoped to the calling tenant (cross-tenant calls return 403).
 *
 *   GET /:tenantId/storage/thresholds  \u2192 { tenantId, thresholds,
 *                                          defaults, source, updatedAt }
 *   PUT /:tenantId/storage/thresholds  \u2192 body { thresholds: number[] }
 *                                          replaces the override; `null`
 *                                          may NOT be passed via PUT \u2014
 *                                          use DELETE for that.
 *   DELETE /:tenantId/storage/thresholds \u2192 clears the override and reverts
 *                                          to the deployment defaults.
 *
 * Validation rules (issue #196 acceptance criteria):
 *   - Each entry must be a finite number in `(0, 1.5]`. Values > 1.0
 *     are allowed deliberately so hosts can alert on overage.
 *   - Max 8 entries.
 *   - Duplicates (after 3-decimal normalization) are deduped silently.
 *
 * See:
 *   - models/TenantRecord.ts                        \u2014 storage shape +
 *                                                     constants
 *   - services/tenant/tenantRecordService.ts        \u2014 validator + writer
 *   - services/tenant/storageThresholdEvaluator.ts  \u2014 the evaluator that
 *                                                     consumes the
 *                                                     persisted config
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { requireUserOrTenantScopes } from '../middleware/hostApiKeyAuth.js';
import {
  DEFAULT_STORAGE_THRESHOLDS,
  STORAGE_THRESHOLDS_MAX_COUNT,
  STORAGE_THRESHOLD_MAX,
  STORAGE_THRESHOLD_MIN_EXCLUSIVE,
} from '../models/TenantRecord.js';
import {
  getTenantRecord,
  patchTenantRecord,
  validateStorageThresholdsInput,
} from '../services/tenant/tenantRecordService.js';
import { isValidTenantId } from '../domain/tenant/Tenant.js';
import { logger } from '../utils/logger.js';

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

interface ResponseBody {
  tenantId: string;
  thresholds: number[];
  defaults: readonly number[];
  override: number[] | null;
  source: 'tenant' | 'deployment';
  updatedAt: string | null;
}

function buildResponse(
  tenantId: string,
  override: number[] | null,
  updatedAt: string | null
): ResponseBody {
  const effective =
    override && override.length > 0 ? override : [...DEFAULT_STORAGE_THRESHOLDS];
  return {
    tenantId,
    thresholds: effective,
    defaults: DEFAULT_STORAGE_THRESHOLDS,
    override,
    source: override && override.length > 0 ? 'tenant' : 'deployment',
    updatedAt,
  };
}

export interface TenantStorageThresholdsRouterDeps {
  dataAdapter: DataAdapter;
}

export function createTenantStorageThresholdsRouter(
  deps: TenantStorageThresholdsRouterDeps
): Router {
  const router = Router({ mergeParams: true });

  // GET /:tenantId/storage/thresholds
  router.get(
    '/:tenantId/storage/thresholds',
    requireUserOrTenantScopes({
      scopes: ['tenants.read'],
      tenantIdFromReq: (req) => (req.params.tenantId as string) || undefined,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        if (!isValidTenantId(tenantId)) {
          sendError(res, 400, 'INVALID_TENANT_ID', 'Invalid tenantId');
          return;
        }
        const record = await getTenantRecord(deps.dataAdapter, tenantId);
        const override =
          record.storageThresholds && record.storageThresholds.length > 0
            ? record.storageThresholds
            : null;
        res
          .status(200)
          .json(buildResponse(tenantId, override, record.updatedAt));
      } catch (err) {
        next(err);
      }
    }
  );

  // PUT /:tenantId/storage/thresholds
  router.put(
    '/:tenantId/storage/thresholds',
    requireUserOrTenantScopes({
      scopes: ['tenants.write'],
      tenantIdFromReq: (req) => (req.params.tenantId as string) || undefined,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        if (!isValidTenantId(tenantId)) {
          sendError(res, 400, 'INVALID_TENANT_ID', 'Invalid tenantId');
          return;
        }
        const body = (req.body || {}) as { thresholds?: unknown };
        if (!('thresholds' in body)) {
          sendError(
            res,
            400,
            'INVALID_BODY',
            'Request body must include `thresholds`',
            {
              constraints: {
                maxCount: STORAGE_THRESHOLDS_MAX_COUNT,
                minExclusive: STORAGE_THRESHOLD_MIN_EXCLUSIVE,
                max: STORAGE_THRESHOLD_MAX,
              },
            }
          );
          return;
        }
        let normalized: number[] | null;
        try {
          normalized = validateStorageThresholdsInput(body.thresholds);
        } catch (err) {
          sendError(
            res,
            400,
            'INVALID_BODY',
            err instanceof Error ? err.message : 'Invalid thresholds payload',
            {
              constraints: {
                maxCount: STORAGE_THRESHOLDS_MAX_COUNT,
                minExclusive: STORAGE_THRESHOLD_MIN_EXCLUSIVE,
                max: STORAGE_THRESHOLD_MAX,
              },
            }
          );
          return;
        }
        // PUT requires a concrete array. Use DELETE to clear.
        if (normalized === null) {
          sendError(
            res,
            400,
            'INVALID_BODY',
            'PUT requires a non-null `thresholds` array; use DELETE to clear the override'
          );
          return;
        }
        const updated = await patchTenantRecord(deps.dataAdapter, tenantId, {
          storageThresholds: normalized,
        });
        res
          .status(200)
          .json(buildResponse(tenantId, normalized, updated.updatedAt));
      } catch (err) {
        logger.error({ err }, 'PUT /storage/thresholds failed');
        next(err);
      }
    }
  );

  // DELETE /:tenantId/storage/thresholds \u2014 revert to defaults.
  router.delete(
    '/:tenantId/storage/thresholds',
    requireUserOrTenantScopes({
      scopes: ['tenants.write'],
      tenantIdFromReq: (req) => (req.params.tenantId as string) || undefined,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        if (!isValidTenantId(tenantId)) {
          sendError(res, 400, 'INVALID_TENANT_ID', 'Invalid tenantId');
          return;
        }
        const updated = await patchTenantRecord(deps.dataAdapter, tenantId, {
          storageThresholds: null,
        });
        res.status(200).json(buildResponse(tenantId, null, updated.updatedAt));
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
