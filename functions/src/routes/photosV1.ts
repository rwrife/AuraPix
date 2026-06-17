/**
 * /v1/photos — Trash (soft-delete) + tag mutation endpoints.
 *
 * Routes:
 *   DELETE /v1/photos/:id          → soft-delete (sets trashedAt)            (#152)
 *   POST   /v1/photos/:id/restore  → clears trashedAt                        (#152)
 *   GET    /v1/photos?trashed=true → list trashed photos for caller's tenant (#152)
 *   GET    /v1/photos              → list active photos for caller's tenant  (#152)
 *   GET    /v1/photos?tags=a,b     → narrow list by tags (AND semantics)     (#173)
 *   POST   /v1/photos/:id/tags     → add/remove tags on a photo              (#173)
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
import {
  parseTagsQuery,
  TagValidationError,
} from '../domain/photos/tagNormalization.js';

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
      let tags: string[] = [];
      try {
        tags = parseTagsQuery(req.query.tags);
      } catch (err) {
        if (err instanceof TagValidationError) {
          sendError(res, 400, err.code, err.message);
          return;
        }
        throw err;
      }
      const items = tags.length
        ? await photos.list(callerTenant(req), { trashed, tags })
        : await photos.list(callerTenant(req), { trashed });
      res.json({
        photos: items.map((p) => ({
          id: p.id,
          libraryId: p.libraryId,
          originalName: p.originalName,
          status: p.status,
          trashedAt: p.trashedAt ?? null,
          trashedBy: p.trashedBy ?? null,
          tags: p.tags ?? [],
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

  router.post('/:id/tags', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const body = (req.body ?? {}) as { add?: unknown; remove?: unknown };
      const { photo, mutation } = await photos.updateTags(
        req.params.id,
        callerTenant(req),
        callerActor(req),
        body
      );
      res.status(200).json({
        id: photo.id,
        tags: photo.tags ?? [],
        added: mutation.added,
        removed: mutation.removed,
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
      if (err instanceof TagValidationError) {
        sendError(res, 400, err.code, err.message);
        return;
      }
      next(err);
    }
  });

  return router;
}

export function createLibraryTagsRouter(photos: PhotosService): Router {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const libraryId = (req.params as { libraryId?: string }).libraryId ?? '';
      if (!libraryId) {
        sendError(res, 400, 'LIBRARY_ID_REQUIRED', 'libraryId path parameter is required');
        return;
      }
      const items = await photos.listLibraryTags(
        libraryId,
        callerTenant(req)
      );
      res.json({ tags: items });
    } catch (err) {
      if (err instanceof CrossTenantAccessError) {
        sendError(res, 403, err.code, err.message);
        return;
      }
      next(err);
    }
  });

  return router;
}
