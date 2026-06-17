/**
 * Per-tenant plugin allowlist endpoints (issue #166).
 *
 * Mounted at `/api/v1/tenants/:tenantId/plugins`. Both endpoints are
 * host-API-key only — the issue is explicit that an authenticated user
 * MUST NOT be able to read or mutate plugin configuration via this surface
 * (this is a host configuration concern, not a user-facing one).
 *
 *   GET  /:tenantId/plugins                → list manifest with per-tenant
 *                                            `enabled` flag.
 *   PUT  /:tenantId/plugins/:pluginId      → toggle enable/disable.
 *
 * Auth model:
 *   - The host API key middleware (`createHostApiKeyAuth`) populates
 *     `req.tenant` when `Authorization: Bearer ak_live_...` is present.
 *   - `req.tenant.id` MUST equal `:tenantId` (cross-tenant requests
 *     return 403).
 *   - The `plugins.read` scope is required for GET; `plugins.write` for
 *     PUT.
 *
 * Metering:
 *   - PUT emits `plugin.enabled` or `plugin.disabled` (only on actual
 *     state change) so hosts can audit upgrades/downgrades.
 *   - The runtime executor (separate path) emits `plugin.blocked` when a
 *     user attempts to run a disabled plugin — see EditProcessor /
 *     applyEdits handler.
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import {
  EDIT_PLUGIN_MANIFEST,
  type EditOperationType,
} from '../services/edits/pluginRegistry.js';
import {
  fetchTenantPluginConfig,
  getEffectiveEnabledPluginIds,
  getOrInitTenantPluginConfig,
  setTenantPluginEnabled,
} from '../services/host/tenantPluginConfigService.js';
import {
  emitMeteringEvent,
  resolveTenantId,
} from '../services/metering/index.js';
import type { TenantApiKeyScope } from '../models/TenantApiKey.js';

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
 * Host-API-key-only guard. Unlike `requireUserOrTenantScopes`, a request
 * with only a Firebase user token is rejected — these endpoints are host
 * configuration and intentionally not user-callable.
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
        'Plugin configuration endpoints require a host API key'
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

const ALL_PLUGIN_ID_SET = new Set<EditOperationType>(
  EDIT_PLUGIN_MANIFEST.map((p) => p.id)
);

function parsePluginId(value: unknown): EditOperationType | null {
  if (typeof value !== 'string') return null;
  return ALL_PLUGIN_ID_SET.has(value as EditOperationType)
    ? (value as EditOperationType)
    : null;
}

function parseEnabled(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

export interface TenantPluginsRouterDeps {
  dataAdapter: DataAdapter;
}

export function createTenantPluginsRouter(
  deps: TenantPluginsRouterDeps
): Router {
  const router = Router({ mergeParams: true });

  // GET /:tenantId/plugins → list of { id, name, version, enabled, builtIn }
  router.get(
    '/:tenantId/plugins',
    requireTenantHostKey('plugins.read'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const actor = req.tenant?.keyId ?? null;

        // Lazy-init writes the default-on doc on first read so admin tooling
        // can see the effective state without ambiguity (issue #166: rollout
        // includes a backfill writing the current full enabled set).
        const config = await getOrInitTenantPluginConfig(
          deps.dataAdapter,
          tenantId,
          { actor }
        );
        const enabled = new Set(config.enabledPluginIds);

        res.json({
          tenantId,
          updatedAt: config.updatedAt,
          updatedBy: config.updatedBy,
          plugins: EDIT_PLUGIN_MANIFEST.map((plugin) => ({
            id: plugin.id,
            name: plugin.displayName,
            version: plugin.version,
            enabled: enabled.has(plugin.id),
            builtIn: true,
          })),
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // PUT /:tenantId/plugins/:pluginId → { enabled: boolean }
  router.put(
    '/:tenantId/plugins/:pluginId',
    requireTenantHostKey('plugins.write'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const pluginIdRaw = String(req.params.pluginId);
        const pluginId = parsePluginId(pluginIdRaw);
        if (!pluginId) {
          sendError(
            res,
            404,
            'PLUGIN_NOT_FOUND',
            `Unknown plugin id: ${pluginIdRaw}`,
            { pluginId: pluginIdRaw }
          );
          return;
        }

        const enabled = parseEnabled(
          (req.body as { enabled?: unknown } | undefined)?.enabled
        );
        if (enabled === null) {
          sendError(
            res,
            400,
            'VALIDATION_ERROR',
            'Body must include `enabled: boolean`'
          );
          return;
        }

        const actor = req.tenant?.keyId ?? null;

        const result = await setTenantPluginEnabled(deps.dataAdapter, {
          tenantId,
          pluginId,
          enabled,
          actor,
        });

        // Emit audit/billing event only on actual state transitions to keep
        // the host's billing surface idempotent.
        if (result.changed) {
          emitMeteringEvent({
            tenantId: resolveTenantId({ tenantId }),
            type: enabled ? 'plugin.enabled' : 'plugin.disabled',
            count: 1,
            resourceId: pluginId,
            meta: {
              tenantId,
              pluginId,
              actor,
            },
          });
        }

        res.json({
          tenantId,
          pluginId,
          enabled,
          changed: result.changed,
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

/**
 * Test surface: re-export internals helpful for unit testing without
 * reaching into the route layer.
 */
export const __test = {
  fetchTenantPluginConfig,
  getEffectiveEnabledPluginIds,
};
