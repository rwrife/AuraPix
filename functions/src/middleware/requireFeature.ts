/**
 * `requireFeature(name)` middleware (issue #175).
 *
 * Gates a route group on a per-tenant feature flag. When the named
 * feature is disabled for the tenant on the request, the middleware
 * responds with HTTP 403 and a structured error payload:
 *
 *     { "error": "feature_disabled", "feature": "<name>" }
 *
 * It additionally emits a low-volume `feature.gated` metering event so
 * hosts can detect upsell opportunities (e.g. "this tenant tried
 * `export` 14 times this week, offer them Pro").
 *
 * Default-on behavior: if a tenant has no feature config doc, every
 * feature reads as enabled (back-compat). Errors fetching the config
 * also fail-open \u2014 we never block a request because the flag store
 * is unreachable. The middleware is designed to be cheap on the hot
 * path; the service layer is responsible for caching.
 */

import type { NextFunction, Request, Response } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { isFeatureEnabled } from '../services/host/tenantFeaturesConfigService.js';
import type { FeatureFlagName } from '../models/TenantFeaturesConfig.js';
import {
  emitMeteringEvent,
  resolveTenantId,
} from '../services/metering/index.js';
import { logger } from '../utils/logger.js';

/**
 * Resolve the tenantId associated with the request.
 *
 * Order of precedence:
 *   1. `req.tenant?.id`     \u2014 host API key authenticated callers
 *   2. `req.params.tenantId` \u2014 routes mounted under `/:tenantId/...`
 *   3. `req.params.libraryId` (legacy) or `req.user?.uid` \u2014 fallback
 *      while the tenantId model rolls out (matches the convention in
 *      `tenantUsage`).
 *
 * Returns null when no tenant can be derived; the middleware treats this
 * as "no gate to apply" and forwards to next().
 */
function resolveRequestTenantId(req: Request): string | null {
  if (req.tenant?.id) return req.tenant.id;
  // `req.tenantId` is populated by the resolveTenant middleware (claim /
  // header / default). Prefer it over path params because it has already
  // been normalized and reflects whatever the auth pipeline resolved.
  const resolved = (req as Request & { tenantId?: string }).tenantId;
  if (typeof resolved === 'string' && resolved.length > 0) return resolved;
  const paramTenantId = (req.params as { tenantId?: string } | undefined)?.tenantId;
  if (paramTenantId) return paramTenantId;
  const paramLibraryId = (req.params as { libraryId?: string } | undefined)
    ?.libraryId;
  if (paramLibraryId) return paramLibraryId;
  if (req.user?.uid) return req.user.uid;
  return null;
}

export interface RequireFeatureOptions {
  /**
   * Override how the tenantId is resolved from the request. Defaults to
   * `resolveRequestTenantId` above.
   */
  resolveTenantId?: (req: Request) => string | null;
}

/**
 * Build the middleware factory. The factory is curried (`createRequireFeature(data)`
 * \u2192 `requireFeature(name)`) so the server can wire the data adapter once
 * at startup and individual route mounts pick the flag name.
 */
export function createRequireFeature(
  dataAdapter: DataAdapter,
  opts: RequireFeatureOptions = {}
) {
  const resolve = opts.resolveTenantId ?? resolveRequestTenantId;

  return function requireFeature(feature: FeatureFlagName) {
    return async function requireFeatureMiddleware(
      req: Request,
      res: Response,
      next: NextFunction
    ): Promise<void> {
      const tenantId = resolve(req);
      // No tenant context \u2014 we cannot check the flag. Fail open so we
      // do not break unauthenticated or pre-tenant-resolution routes.
      if (!tenantId) {
        next();
        return;
      }

      let enabled = true;
      try {
        enabled = await isFeatureEnabled(dataAdapter, tenantId, feature);
      } catch (err) {
        // Fail open on adapter errors. The host can still detect a
        // misconfiguration via standard error monitoring; blocking
        // requests because the config store is unreachable would
        // amplify incidents into customer-visible outages.
        logger.warn(
          { err, tenantId, feature },
          'requireFeature: failed to resolve flag, failing open'
        );
        next();
        return;
      }

      if (enabled) {
        next();
        return;
      }

      // Gated. Emit a metering event \u2014 hosts use this as an upsell
      // signal. `route` is intentionally the registered Express route
      // path (e.g. `/v1/photos/:photoId/export`), not the concrete URL,
      // so it groups cleanly in rollups without leaking ids.
      try {
        emitMeteringEvent({
          tenantId: resolveTenantId({ tenantId }),
          type: 'feature.gated',
          count: 1,
          meta: {
            feature,
            route: req.route?.path ?? req.baseUrl ?? req.path ?? null,
            method: req.method,
            userId: req.user?.uid ?? null,
            keyId: req.tenant?.keyId ?? null,
          },
        });
      } catch (err) {
        // Metering MUST NOT affect the response.
        logger.debug({ err, tenantId, feature }, 'feature.gated emit failed');
      }

      res.status(403).json({
        error: 'feature_disabled',
        feature,
      });
    };
  };
}

/**
 * Type alias for the curried middleware factory \u2014 lets callers type
 * the per-feature factory without re-deriving the return type.
 */
export type RequireFeatureFactory = ReturnType<typeof createRequireFeature>;
