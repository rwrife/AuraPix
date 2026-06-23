/**
 * Per-tenant Trash retention config endpoints (issue #183).
 *
 * Mounted at `/v1/tenants/:tenantId/config/trash` (and the legacy
 * `/api/v1/tenants/...` alias). Both endpoints are host-API-key only
 * with the `tenant.config` scope (shared with the feature-flag config
 * router; trash retention is also a host configuration concern that
 * maps to pricing tiers, not a user-tunable preference).
 *
 *   GET   /:tenantId/config/trash   → { tenantId, retentionDays, source,
 *                                       updatedAt, updatedBy }
 *   PATCH /:tenantId/config/trash   → { retentionDays: number | null }
 *                                       emits `feature.flag_changed` with
 *                                       `flag="trash.retentionDays"`.
 *
 * Validation: `retentionDays` MUST be an integer in `[1, 365]`.
 * `null` clears the override and reverts to the deployment default.
 *
 * See:
 *   - models/TenantFeaturesConfig.ts        — storage shape, min/max
 *   - services/host/tenantFeaturesConfigService.ts — read + PATCH helpers
 *   - jobs/purgeTrash.ts                    — purge job honors the override
 *   - contracts/openapi/tenant-trash-config.openapi.json — contract
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import {
  TRASH_RETENTION_MAX_DAYS,
  TRASH_RETENTION_MIN_DAYS,
} from '../models/TenantFeaturesConfig.js';
import {
  clampTrashRetentionDays,
  fetchTenantFeaturesConfig,
  patchTrashRetention,
} from '../services/host/tenantFeaturesConfigService.js';
import {
  emitMeteringEvent,
  resolveTenantId,
} from '../services/metering/index.js';
import { recordAuditEvent } from '../services/audit/AuditService.js';
import {
  DEFAULT_TRASH_RETENTION_DAYS,
  resolveTrashRetentionDays,
} from '../jobs/purgeTrash.js';
import type { TenantApiKeyScope } from '../models/TenantApiKey.js';
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

/**
 * Host-API-key-only guard. Mirrors the pattern in `tenantFeaturesV1.ts`.
 */
function requireTenantHostKey(scope: TenantApiKeyScope) {
  return function guard(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const tenantId = String(req.params.tenantId ?? '');
    if (!tenantId) {
      sendError(res, 400, 'VALIDATION_ERROR', 'tenantId is required');
      return;
    }
    if (!req.tenant) {
      sendError(
        res,
        401,
        'HOST_API_KEY_REQUIRED',
        'Trash retention configuration endpoints require a host API key'
      );
      return;
    }
    if (req.tenant.id !== tenantId) {
      sendError(
        res,
        403,
        'CROSS_TENANT_FORBIDDEN',
        'Cross-tenant request rejected'
      );
      return;
    }
    if (!new Set(req.tenant.scopes).has(scope)) {
      sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Insufficient scope', {
        missing: [scope],
      });
      return;
    }
    next();
  };
}

/**
 * PATCH body schema. `retentionDays` may be a positive integer in range
 * or `null` to clear the override and revert to the deployment default.
 */
const PatchSchema = z
  .object({
    retentionDays: z
      .union([
        z
          .number()
          .int()
          .min(TRASH_RETENTION_MIN_DAYS)
          .max(TRASH_RETENTION_MAX_DAYS),
        z.null(),
      ])
      .describe(
        `Integer in [${TRASH_RETENTION_MIN_DAYS}, ${TRASH_RETENTION_MAX_DAYS}], or null to clear.`
      ),
  })
  .strict();

export interface TenantTrashConfigRouterDeps {
  dataAdapter: DataAdapter;
  /**
   * Test hook: override the deployment-default resolver. Defaults to
   * reading `TRASH_RETENTION_DAYS` from `process.env`.
   */
  resolveDeploymentDefault?: () => number;
}

export function createTenantTrashConfigRouter(
  deps: TenantTrashConfigRouterDeps
): Router {
  const router = Router({ mergeParams: true });
  const deploymentDefault = () =>
    deps.resolveDeploymentDefault
      ? deps.resolveDeploymentDefault()
      : resolveTrashRetentionDays();

  // GET /:tenantId/config/trash
  router.get(
    '/:tenantId/config/trash',
    requireTenantHostKey('tenant.config'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const doc = await fetchTenantFeaturesConfig(deps.dataAdapter, tenantId);
        const override = clampTrashRetentionDays(doc?.trashRetentionDays);
        const fallback = deploymentDefault();
        const effective = override ?? fallback;
        res.status(200).json({
          tenantId,
          retentionDays: effective,
          override,
          deploymentDefault: fallback,
          source: override !== null ? 'tenant' : 'deployment',
          updatedAt: doc?.updatedAt ?? null,
          updatedBy: doc?.updatedBy ?? null,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // PATCH /:tenantId/config/trash
  router.patch(
    '/:tenantId/config/trash',
    requireTenantHostKey('tenant.config'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const parsed = PatchSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          sendError(
            res,
            400,
            'INVALID_BODY',
            'Invalid trash retention payload',
            { issues: parsed.error.issues }
          );
          return;
        }

        const actor = req.tenant?.keyId ?? null;
        const fallback = deploymentDefault();
        let result;
        try {
          result = await patchTrashRetention(deps.dataAdapter, {
            tenantId,
            retentionDays: parsed.data.retentionDays,
            actor,
          });
        } catch (err) {
          if (err instanceof RangeError) {
            // Defensive: zod already rejects out-of-range values, but
            // surfacing the service-layer error keeps both layers honest.
            sendError(res, 400, 'INVALID_BODY', err.message);
            return;
          }
          throw err;
        }

        // Emit `feature.flag_changed` with `flag="trash.retentionDays"`
        // so hosts can correlate plan changes with bill deltas (the
        // event already exists in the catalog).
        if (result.changed) {
          const actorLabel = actor
            ? `host-api-key:${actor.substring(0, 8)}`
            : 'host-api-key';
          try {
            emitMeteringEvent({
              tenantId: resolveTenantId({ tenantId }),
              type: 'feature.flag_changed',
              count: 1,
              resourceId: 'trash.retentionDays',
              meta: {
                tenantId,
                feature: 'trash.retentionDays',
                // The existing schema is { oldValue: boolean, newValue: boolean }
                // and uses `additionalProperties: true`, so we also publish the
                // numeric values for hosts that want to inspect them.
                oldValue: result.previous,
                newValue: result.next,
                actor: actorLabel,
              },
            });
          } catch (err) {
            logger.debug(
              { err, tenantId },
              'feature.flag_changed emit failed for trash.retentionDays'
            );
          }

          // Audit event for compliance trails (same pattern as
          // tenant.features and branding routes).
          try {
            await recordAuditEvent(deps.dataAdapter, {
              eventType: 'tenant.config.trash.updated',
              actorId: actor ?? 'host-api-key',
              targetId: tenantId,
              tenantId,
              resourceType: 'tenant-config',
              createdAt: result.record.updatedAt,
              metadata: {
                tenantId,
                previous: result.previous,
                next: result.next,
              },
            });
          } catch (auditErr) {
            logger.warn(
              { err: auditErr, tenantId },
              'Failed to record tenant.config.trash audit event'
            );
          }
        }

        const effective = result.next ?? fallback;
        res.status(200).json({
          tenantId,
          retentionDays: effective,
          override: result.next,
          deploymentDefault: fallback,
          source: result.next !== null ? 'tenant' : 'deployment',
          updatedAt: result.record.updatedAt,
          updatedBy: result.record.updatedBy,
          changed: result.changed,
          previous: result.previous,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

/**
 * Test surface.
 */
export const __test = {
  PatchSchema,
  DEFAULT_TRASH_RETENTION_DAYS,
};
