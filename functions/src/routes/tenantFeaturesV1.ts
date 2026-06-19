/**
 * Per-tenant feature flag endpoints (issue #175).
 *
 * Mounted at `/v1/tenants/:tenantId/features` (and the legacy
 * `/api/v1/tenants/...` alias). Both endpoints are host-API-key only
 * with the `tenant.config` scope \u2014 feature flags are a host
 * configuration concern (they map to pricing tiers) and are NOT
 * user-tunable.
 *
 *   GET   /:tenantId/features        \u2192 effective flag map (defaults
 *                                       merged in) plus metadata.
 *   PATCH /:tenantId/features        \u2192 partial update; emits
 *                                       `feature.flag_changed` for each
 *                                       transitioning flag.
 *
 * Defaults: tenants with no doc read every feature as `true` (back-compat).
 * Unknown keys in PATCH bodies are silently ignored at the service layer.
 *
 * See:
 *   - models/TenantFeaturesConfig.ts        \u2014 storage shape, defaults
 *   - services/host/tenantFeaturesConfigService.ts \u2014 cached read + PATCH
 *   - middleware/requireFeature.ts          \u2014 the per-route gate
 *   - contracts/openapi/tenant-features.openapi.json \u2014 contract
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import {
  FEATURE_FLAG_NAMES,
  type FeatureFlagName,
} from '../models/TenantFeaturesConfig.js';
import {
  fetchTenantFeaturesConfig,
  getEffectiveFeatureFlags,
  patchTenantFeatures,
} from '../services/host/tenantFeaturesConfigService.js';
import {
  emitMeteringEvent,
  resolveTenantId,
} from '../services/metering/index.js';
import { recordAuditEvent } from '../services/audit/AuditService.js';
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
 * Host-API-key-only guard. Mirrors `requireTenantHostKey` in the
 * plugin-config router: rejects user-Bearer tokens entirely.
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
        'Feature flag configuration endpoints require a host API key'
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
 * PATCH body schema. Every flag is optional; unknown keys are stripped
 * by zod's default `.strict()`-free behavior, and the service layer also
 * ignores them defensively.
 */
const PatchSchema = z
  .object(
    Object.fromEntries(
      FEATURE_FLAG_NAMES.map((name) => [name, z.boolean().optional()])
    ) as Record<FeatureFlagName, z.ZodOptional<z.ZodBoolean>>
  )
  .strict();

export interface TenantFeaturesRouterDeps {
  dataAdapter: DataAdapter;
}

export function createTenantFeaturesRouter(
  deps: TenantFeaturesRouterDeps
): Router {
  const router = Router({ mergeParams: true });

  // GET /:tenantId/features
  router.get(
    '/:tenantId/features',
    requireTenantHostKey('tenant.config'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const flags = await getEffectiveFeatureFlags(deps.dataAdapter, tenantId);
        const doc = await fetchTenantFeaturesConfig(deps.dataAdapter, tenantId);
        res.status(200).json({
          tenantId,
          flags,
          updatedAt: doc?.updatedAt ?? null,
          updatedBy: doc?.updatedBy ?? null,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // PATCH /:tenantId/features
  router.patch(
    '/:tenantId/features',
    requireTenantHostKey('tenant.config'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const parsed = PatchSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          sendError(res, 400, 'INVALID_BODY', 'Invalid feature flag payload', {
            issues: parsed.error.issues,
          });
          return;
        }

        const actor = req.tenant?.keyId ?? null;
        const result = await patchTenantFeatures(deps.dataAdapter, {
          tenantId,
          patch: parsed.data as Partial<Record<FeatureFlagName, boolean>>,
          actor,
        });

        // Emit one `feature.flag_changed` per transitioning flag so the
        // host's audit log has a clean per-feature trail. `actor` is the
        // API key id with a short prefix so audit consumers can identify
        // which integration flipped the flag without exposing the secret.
        const actorLabel = actor ? `host-api-key:${actor.substring(0, 8)}` : 'host-api-key';
        for (const change of result.changes) {
          try {
            emitMeteringEvent({
              tenantId: resolveTenantId({ tenantId }),
              type: 'feature.flag_changed',
              count: 1,
              resourceId: change.feature,
              meta: {
                tenantId,
                feature: change.feature,
                oldValue: change.oldValue,
                newValue: change.newValue,
                actor: actorLabel,
              },
            });
          } catch (err) {
            logger.debug(
              { err, tenantId, feature: change.feature },
              'feature.flag_changed emit failed'
            );
          }
        }

        // Audit event for compliance trails (same pattern as branding).
        if (result.changes.length > 0) {
          try {
            await recordAuditEvent(deps.dataAdapter, {
              eventType: 'tenant.features.updated',
              actorId: actor ?? 'host-api-key',
              targetId: tenantId,
              createdAt: result.record.updatedAt,
              metadata: {
                tenantId,
                changes: result.changes,
              },
            });
          } catch (auditErr) {
            logger.warn(
              { err: auditErr, tenantId },
              'Failed to record tenant.features audit event'
            );
          }
        }

        // Return the new effective flags (defaults merged) so the host
        // does not have to re-GET to render UI.
        const flags = await getEffectiveFeatureFlags(deps.dataAdapter, tenantId);
        res.status(200).json({
          tenantId,
          flags,
          updatedAt: result.record.updatedAt,
          updatedBy: result.record.updatedBy,
          changes: result.changes,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

/**
 * Test surface: re-export internals helpful for unit testing.
 */
export const __test = {
  PatchSchema,
};
