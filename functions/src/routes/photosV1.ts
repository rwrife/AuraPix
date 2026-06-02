/**
 * /v1/photos — Trash (soft-delete) endpoints.
 *
 * Routes (issue #152):
 *   DELETE /v1/photos/:id          → soft-delete (sets trashedAt)
 *   POST   /v1/photos/:id/restore  → clears trashedAt
 *   GET    /v1/photos?trashed=true → list trashed photos for caller's tenant
 *   GET    /v1/photos              → list active photos for caller's tenant
 */
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  PhotoNotFoundError,
  type PhotosService,
} from '../domain/photos/PhotosService.js';
import {
  CrossTenantAccessError,
  DEFAULT_TENANT_ID,
  type TenantId,
} from '../domain/tenant/Tenant.js';

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
  return (req.tenantId as TenantId | undefined) ?? DEFAULT_TENANT_ID;
}

function callerActor(req: Request): string | null {
  return req.user?.uid ?? null;
}

export function createPhotosV1Router(photos: PhotosService): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const trashed = req.query.trashed === 'true' || req.query.trashed === '1';
      const items = await photos.list(callerTenant(req), { trashed });
      res.json({
        photos: items.map((p) => ({
          id: p.id,
          libraryId: p.libraryId,
          originalName: p.originalName,
          status: p.status,
          trashedAt: p.trashedAt ?? null,
          trashedBy: p.trashedBy ?? null,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const photo = await photos.softDelete(
        req.params.id,
        callerTenant(req),
        callerActor(req)
      );
      res.status(200).json({
        id: photo.id,
        trashedAt: photo.trashedAt ?? null,
        trashedBy: photo.trashedBy ?? null,
      });
    } catch (err) {
      if (err instanceof PhotoNotFoundError) {
        sendError(res, 404, 'PHOTO_NOT_FOUND', err.message);
        return;
      }
      if (err instanceof CrossTenantAccessError) {
        sendError(res, 403, err.code, err.message);
        return;
      }
      next(err);
    }
  });

  router.post('/:id/restore', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const photo = await photos.restore(req.params.id, callerTenant(req));
      res.status(200).json({
        id: photo.id,
        trashedAt: photo.trashedAt ?? null,
        trashedBy: photo.trashedBy ?? null,
      });
    } catch (err) {
      if (err instanceof PhotoNotFoundError) {
        sendError(res, 404, 'PHOTO_NOT_FOUND', err.message);
        return;
      }
      if (err instanceof CrossTenantAccessError) {
        sendError(res, 403, err.code, err.message);
        return;
      }
      next(err);
    }
  });

  return router;
}
