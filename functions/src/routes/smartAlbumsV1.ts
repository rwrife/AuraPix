/**
 * /v1/libraries/:libraryId/smart-albums and /v1/smart-albums/:id — Smart
 * Albums API (issue #165). Saved filter queries that materialize on read.
 */
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  SmartAlbumNotFoundError,
  SmartAlbumsCapExceededError,
  SmartAlbumValidationError,
  type SmartAlbumsService,
} from '../domain/smartAlbums/SmartAlbumsService.js';
import {
  CrossTenantAccessError,
  DEFAULT_TENANT_ID,
  type TenantId,
} from '../domain/tenant/Tenant.js';
import type { SmartAlbum } from '../domain/smartAlbums/types.js';
import type { Photo } from '../models/Photo.js';

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

function callerOwner(req: Request): string | null {
  return req.user?.uid ?? null;
}

function libraryIdFromReq(req: Request): string {
  const params = req.params as { libraryId?: string };
  return String(params.libraryId ?? '').trim();
}

function serialize(album: SmartAlbum): Record<string, unknown> {
  return {
    id: album.id,
    tenantId: album.tenantId,
    libraryId: album.libraryId,
    ownerId: album.ownerId,
    name: album.name,
    filter: album.filter,
    createdAt: album.createdAt,
    updatedAt: album.updatedAt,
  };
}

function serializePhoto(p: Photo): Record<string, unknown> {
  return {
    id: p.id,
    libraryId: p.libraryId,
    originalName: p.originalName,
    status: p.status,
    metadata: {
      width: p.metadata?.width,
      height: p.metadata?.height,
      mimeType: p.metadata?.mimeType,
      sizeBytes: p.metadata?.sizeBytes,
      takenAt: p.metadata?.takenAt ?? null,
    },
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function handleServiceError(res: Response, err: unknown): boolean {
  if (err instanceof SmartAlbumNotFoundError) {
    sendError(res, 404, 'SMART_ALBUM_NOT_FOUND', err.message);
    return true;
  }
  if (err instanceof SmartAlbumsCapExceededError) {
    sendError(res, 409, 'SMART_ALBUM_CAP_EXCEEDED', err.message, {
      cap: err.cap,
      libraryId: err.libraryId,
    });
    return true;
  }
  if (err instanceof SmartAlbumValidationError) {
    sendError(res, 400, 'SMART_ALBUM_INVALID_FILTER', err.message, {
      issues: err.issues,
    });
    return true;
  }
  if (err instanceof CrossTenantAccessError) {
    sendError(res, 403, err.code, err.message);
    return true;
  }
  return false;
}

/**
 * Library-scoped router: list + create.
 * Mounted at `/v1/libraries/:libraryId/smart-albums` so the URL captures
 * which library a smart album belongs to.
 */
export function createSmartAlbumsLibraryRouter(
  service: SmartAlbumsService
): Router {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const libraryId = libraryIdFromReq(req);
      if (!libraryId) {
        sendError(res, 400, 'INVALID_PATH', 'libraryId is required');
        return;
      }
      const items = await service.list(callerTenant(req), libraryId);
      res.json({ smartAlbums: items.map(serialize) });
    } catch (err) {
      if (handleServiceError(res, err)) return;
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const libraryId = libraryIdFromReq(req);
      if (!libraryId) {
        sendError(res, 400, 'INVALID_PATH', 'libraryId is required');
        return;
      }
      const ownerId = callerOwner(req);
      if (!ownerId) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const created = await service.create({
        libraryId,
        ownerId,
        tenantId: callerTenant(req),
        name: req.body?.name,
        filter: req.body?.filter ?? {},
      });
      res.status(201).json({ smartAlbum: serialize(created) });
    } catch (err) {
      if (handleServiceError(res, err)) return;
      next(err);
    }
  });

  return router;
}

/**
 * Resource router: get / patch / delete / materialize.
 * Mounted at `/v1/smart-albums/:id`.
 */
export function createSmartAlbumsResourceRouter(
  service: SmartAlbumsService
): Router {
  const router = Router();

  router.get('/:id', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const id = String(req.params.id ?? '').trim();
      const album = await service.get(id, callerTenant(req));
      res.json({ smartAlbum: serialize(album) });
    } catch (err) {
      if (handleServiceError(res, err)) return;
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const id = String(req.params.id ?? '').trim();
      const updated = await service.update(id, callerTenant(req), {
        name: req.body?.name,
        filter: req.body?.filter,
      });
      res.json({ smartAlbum: serialize(updated) });
    } catch (err) {
      if (handleServiceError(res, err)) return;
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const id = String(req.params.id ?? '').trim();
      await service.remove(id, callerTenant(req));
      res.status(204).send();
    } catch (err) {
      if (handleServiceError(res, err)) return;
      next(err);
    }
  });

  router.get('/:id/photos', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const id = String(req.params.id ?? '').trim();
      const pageSizeRaw = req.query.pageSize;
      const pageSize =
        typeof pageSizeRaw === 'string' && pageSizeRaw.trim()
          ? Number(pageSizeRaw)
          : undefined;
      if (pageSize !== undefined && (!Number.isFinite(pageSize) || pageSize <= 0)) {
        sendError(res, 400, 'INVALID_QUERY', 'pageSize must be a positive integer');
        return;
      }
      const pageToken =
        typeof req.query.pageToken === 'string' && req.query.pageToken.trim()
          ? req.query.pageToken.trim()
          : null;

      const result = await service.materialize(id, callerTenant(req), {
        pageSize,
        pageToken,
      });
      res.json({
        photos: result.photos.map(serializePhoto),
        nextPageToken: result.nextPageToken,
        total: result.total,
      });
    } catch (err) {
      if (handleServiceError(res, err)) return;
      next(err);
    }
  });

  return router;
}
