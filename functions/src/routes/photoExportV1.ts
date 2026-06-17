/**
 * Photo export endpoint (issue #174).
 *
 * Routes:
 *   POST /v1/photos/:id/export        → render-or-cache and return signed URL
 *   GET  /v1/photos/:id/export/:token → stream the cached export bytes
 *
 * Auth model: the POST endpoint requires either an authenticated user
 * (via `authMiddleware`) or a host API key with the
 * `export-presets.read` scope. The GET endpoint is unauthenticated but
 * gated by an HMAC-signed short-lived token (5 minutes default), the
 * same pattern as the existing signed-URL image serve.
 *
 * Metering: emits `photo.exported` with `outputBytes` measured directly
 * from the rendered buffer, plus a `cacheHit` flag so hosts can choose
 * to discount cache hits. Also publishes `exportBytes` onto the rollup
 * bus so the daily `/v1/tenants/:id/usage` document carries the egress
 * total without parsing every event.
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../adapters/storage/StorageAdapter.js';
import type { Photo } from '../models/Photo.js';
import {
  assertSameTenant,
  CrossTenantAccessError,
  DEFAULT_TENANT_ID,
  type TenantId,
} from '../domain/tenant/Tenant.js';
import {
  emitMeteringEvent,
  resolveTenantId,
} from '../services/metering/index.js';
import type { UsageMeteringBus } from '../services/metering/UsageMeteringBus.js';
import { logger } from '../utils/logger.js';
import {
  computeRecipeHash,
  DEFAULT_EXPORT_URL_TTL_SECONDS,
  renderExport,
  signExportToken,
  verifyExportToken,
} from '../services/image/exportService.js';
import { resolvePresetByName } from '../services/host/exportPresetService.js';

const PHOTOS_COLLECTION = 'photos';

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> | null = null
): void {
  res.status(status).json({
    error: {
      code,
      message,
      requestId: randomUUID(),
      details,
    },
  });
}

function callerTenant(req: Request): TenantId {
  // Prefer the explicit tenant context set by host-key auth, then the
  // tenant resolved by `resolveTenant` middleware for user calls.
  if (req.tenant?.id) return req.tenant.id as TenantId;
  return (req.tenantId as TenantId | undefined) ?? DEFAULT_TENANT_ID;
}

export interface PhotoExportRouterDeps {
  dataAdapter: DataAdapter;
  storageAdapter: StorageAdapter;
  /**
   * Optional rollup bus so we can increment `exportBytes` per export.
   * Resolved at request time so wiring code that constructs the router
   * before the bus exists can call `setUsageBus` later.
   */
  usageBus?: UsageMeteringBus;
}

/**
 * Handle returned by `createPhotoExportRouter` so the server wiring can
 * late-bind the usage bus (constructed downstream of route registration).
 */
export interface PhotoExportRouterHandle {
  router: Router;
  /** Late-bind the usage bus. Idempotent; calling twice replaces the binding. */
  setUsageBus(bus: UsageMeteringBus | undefined): void;
}

export function createPhotoExportRouter(
  deps: PhotoExportRouterDeps
): PhotoExportRouterHandle {
  const router = Router({ mergeParams: true });
  let currentBus: UsageMeteringBus | undefined = deps.usageBus;
  const getUsageBus = (): UsageMeteringBus | undefined => currentBus;

  // POST /:id/export — render-or-cache, emit metering, return signed URL.
  router.post('/:id/export', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user && !req.tenant) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const photoId = String(req.params.id);
      const body = (req.body ?? {}) as { preset?: unknown };
      const presetName = typeof body.preset === 'string' ? body.preset.trim() : '';
      if (!presetName) {
        sendError(
          res,
          400,
          'PRESET_REQUIRED',
          'Request body must include a non-empty `preset` field'
        );
        return;
      }

      const photo = await deps.dataAdapter.fetchData<Photo>(
        PHOTOS_COLLECTION,
        photoId
      );
      if (!photo) {
        sendError(res, 404, 'PHOTO_NOT_FOUND', `Photo ${photoId} not found`);
        return;
      }
      try {
        assertSameTenant(photo.tenantId, callerTenant(req));
      } catch (err) {
        if (err instanceof CrossTenantAccessError) {
          sendError(res, 403, err.code, err.message);
          return;
        }
        throw err;
      }
      if (photo.trashedAt) {
        sendError(
          res,
          409,
          'PHOTO_TRASHED',
          'Cannot export a photo that is in the trash'
        );
        return;
      }

      const tenantId = (photo.tenantId ?? DEFAULT_TENANT_ID) as TenantId;
      const preset = await resolvePresetByName(
        deps.dataAdapter,
        tenantId,
        presetName
      );
      if (!preset) {
        sendError(
          res,
          404,
          'PRESET_NOT_FOUND',
          `Preset "${presetName}" is not configured for this tenant`,
          { preset: presetName }
        );
        return;
      }

      // Render (or pull from cache).
      const rendered = await renderExport({
        storage: deps.storageAdapter,
        photo,
        preset,
      });

      // Build a short-lived signed URL pointing back at the GET handler.
      const recipeHash = computeRecipeHash(photo);
      const { token, expiresAt } = signExportToken({
        photoId,
        libraryId: photo.libraryId,
        tenantId,
        presetName: preset.name,
        recipeHash,
      });
      const downloadUrl =
        `${baseUrl(req)}/v1/photos/${encodeURIComponent(photoId)}/export/` +
        encodeURIComponent(token);

      // Metering: photo.exported with outputBytes measured from the buffer.
      // Always emitted (cacheHit or not) so hosts can audit downloads.
      emitMeteringEvent({
        tenantId: resolveTenantId({ tenantId }),
        type: 'photo.exported',
        count: 1,
        bytes: rendered.outputBytes,
        resourceId: photoId,
        meta: {
          libraryId: photo.libraryId,
          preset: preset.name,
          outputWidth: rendered.outputWidth,
          outputHeight: rendered.outputHeight,
          cacheHit: rendered.cacheHit,
          actor: req.tenant?.keyId ?? req.user?.uid ?? null,
        },
      });

      // Roll the bytes into the daily `exportBytes` counter. We use
      // `(photoId, cacheKey, isoTimestamp)` as the idempotency key so
      // repeated POSTs in the same instant don't accidentally dedupe.
      const usageBus = getUsageBus();
      if (usageBus) {
        const occurredAt = new Date().toISOString();
        void usageBus
          .publish({
            tenantId,
            counter: 'exportBytes',
            value: rendered.outputBytes,
            occurredAt,
            eventId: `photo.exported:${photoId}:${rendered.cacheKey}:${occurredAt}`,
            meta: {
              libraryId: photo.libraryId,
              preset: preset.name,
              cacheHit: rendered.cacheHit,
            },
          })
          .catch((err: unknown) => {
            logger.warn(
              { err, photoId },
              'export: usage bus publish failed; continuing'
            );
          });
      }

      res.status(200).json({
        photoId,
        preset: preset.name,
        url: downloadUrl,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        ttlSeconds: DEFAULT_EXPORT_URL_TTL_SECONDS,
        outputBytes: rendered.outputBytes,
        outputWidth: rendered.outputWidth,
        outputHeight: rendered.outputHeight,
        cacheHit: rendered.cacheHit,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /:id/export/:token — verify the HMAC, re-render-from-cache, stream.
  // No auth middleware: the signed token IS the auth, identical to the
  // existing image serve pattern.
  router.get(
    '/:id/export/:token',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const photoId = String(req.params.id);
        const token = String(req.params.token);
        const payload = verifyExportToken(token);
        if (!payload) {
          sendError(
            res,
            401,
            'INVALID_OR_EXPIRED_TOKEN',
            'Export URL is invalid or expired'
          );
          return;
        }
        if (payload.p !== photoId) {
          sendError(res, 400, 'TOKEN_PHOTO_MISMATCH', 'Token does not match photo id');
          return;
        }
        const photo = await deps.dataAdapter.fetchData<Photo>(
          PHOTOS_COLLECTION,
          photoId
        );
        if (!photo) {
          sendError(res, 404, 'PHOTO_NOT_FOUND', 'Photo not found');
          return;
        }
        // Tenancy is baked into the token; defense-in-depth check below.
        if ((photo.tenantId ?? DEFAULT_TENANT_ID) !== payload.t) {
          sendError(res, 403, 'cross-tenant-access', 'Token tenant mismatch');
          return;
        }
        const preset = await resolvePresetByName(
          deps.dataAdapter,
          payload.t,
          payload.n
        );
        if (!preset) {
          sendError(
            res,
            404,
            'PRESET_NOT_FOUND',
            `Preset "${payload.n}" no longer exists`
          );
          return;
        }
        // If the recipe changed between POST and GET, refuse rather than
        // serving stale bytes — the host can re-issue.
        const currentRecipeHash = computeRecipeHash(photo);
        if (currentRecipeHash !== payload.r) {
          sendError(
            res,
            409,
            'RECIPE_CHANGED',
            'Edit recipe changed after URL was issued; please request a new export URL'
          );
          return;
        }
        const rendered = await renderExport({
          storage: deps.storageAdapter,
          photo,
          preset,
        });
        res.set({
          'Content-Type': 'image/jpeg',
          'Content-Length': String(rendered.outputBytes),
          'Cache-Control': 'private, max-age=60',
        });
        res.status(200).send(rendered.buffer);
      } catch (err) {
        next(err);
      }
    }
  );

  return {
    router,
    setUsageBus(bus: UsageMeteringBus | undefined): void {
      currentBus = bus;
    },
  };
}

function baseUrl(req: Request): string {
  // Honor reverse-proxy headers if present (the gateway terminates TLS).
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
    || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim()
    || req.headers.host
    || 'localhost';
  return `${proto}://${host}`;
}
