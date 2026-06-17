/**
 * Per-tenant export-presets endpoints (issue #174).
 *
 * Mounted at `/v1/tenants/:tenantId/export-presets` (and mirrored under
 * `/api/v1/...` for in-product clients). End-user-callable for GET so
 * the export menu can render the preset list; mutations are host API
 * key only — a free-plan tenant should not be able to invent their own
 * `huge-tiff` preset.
 *
 *   GET    /:tenantId/export-presets               → user or host key
 *   PUT    /:tenantId/export-presets/:name         → host key only (write scope)
 *   DELETE /:tenantId/export-presets/:name         → host key only (write scope)
 *
 * Auth shape mirrors `tenantPluginsV1.ts` so admin tooling can authenticate
 * the same way against either surface.
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { TenantApiKeyScope } from '../models/TenantApiKey.js';
import {
  ExportPresetValidationError,
  deleteTenantExportPreset,
  getOrInitTenantExportPresets,
  setTenantExportPreset,
  validatePresetBody,
} from '../services/host/exportPresetService.js';

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
 * Guard: allow either an authenticated user (read-only) OR a host key
 * carrying the requested scope. For host-key calls, enforce cross-tenant
 * rejection on `req.tenant.id` vs `:tenantId`.
 */
function requireUserOrHostKey(scope: TenantApiKeyScope) {
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
    if (req.tenant) {
      if (req.tenant.id !== tenantId) {
        sendError(res, 403, 'CROSS_TENANT_FORBIDDEN', 'Cross-tenant request rejected');
        return;
      }
      if (!new Set(req.tenant.scopes).has(scope)) {
        sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Insufficient scope', {
          missing: [scope],
        });
        return;
      }
      next();
      return;
    }
    if (req.user) {
      next();
      return;
    }
    sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
  };
}

/**
 * Guard: host API key only. Used for the mutation endpoints (PUT / DELETE)
 * since the issue requires that "host API key can CRUD presets; user keys
 * can only read + invoke export".
 */
function requireHostKey(scope: TenantApiKeyScope) {
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
        'Mutating export presets requires a host API key'
      );
      return;
    }
    if (req.tenant.id !== tenantId) {
      sendError(res, 403, 'CROSS_TENANT_FORBIDDEN', 'Cross-tenant request rejected');
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

export interface TenantExportPresetsRouterDeps {
  dataAdapter: DataAdapter;
}

export function createTenantExportPresetsRouter(
  deps: TenantExportPresetsRouterDeps
): Router {
  const router = Router({ mergeParams: true });

  // GET /:tenantId/export-presets
  // Available to either a user (so the in-product Export menu can render)
  // or a host key with `export-presets.read`.
  router.get(
    '/:tenantId/export-presets',
    requireUserOrHostKey('export-presets.read'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const record = await getOrInitTenantExportPresets(
          deps.dataAdapter,
          tenantId
        );
        res.json({
          tenantId: record.tenantId,
          updatedAt: record.updatedAt,
          updatedBy: record.updatedBy,
          presets: record.presets,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // PUT /:tenantId/export-presets/:name
  router.put(
    '/:tenantId/export-presets/:name',
    requireHostKey('export-presets.write'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const name = String(req.params.name);
        let preset;
        try {
          preset = validatePresetBody(name, req.body);
        } catch (err) {
          if (err instanceof ExportPresetValidationError) {
            sendError(res, err.status, err.code, err.message);
            return;
          }
          throw err;
        }
        const actor = req.tenant?.keyId ?? null;
        const result = await setTenantExportPreset(deps.dataAdapter, {
          tenantId,
          preset,
          actor,
        });
        res.json({
          tenantId,
          preset,
          changed: result.changed,
          updatedAt: result.record.updatedAt,
          updatedBy: result.record.updatedBy,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // DELETE /:tenantId/export-presets/:name
  router.delete(
    '/:tenantId/export-presets/:name',
    requireHostKey('export-presets.write'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const name = String(req.params.name);
        const actor = req.tenant?.keyId ?? null;
        const result = await deleteTenantExportPreset(deps.dataAdapter, {
          tenantId,
          name,
          actor,
        });
        res.json({
          tenantId,
          name,
          removed: result.removed,
          updatedAt: result.record.updatedAt,
          updatedBy: result.record.updatedBy,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
