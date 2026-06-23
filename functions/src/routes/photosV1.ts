/**
 * /v1/photos — Trash (soft-delete) + tag mutation + triage endpoints.
 *
 * Routes:
 *   GET    /v1/photos              → list active photos for caller's tenant  (#152)
 *   GET    /v1/photos?trashed=true → list trashed photos for caller's tenant (#152)
 *   GET    /v1/photos?tags=a,b     → narrow list by tags (AND semantics)     (#173)
 *   GET    /v1/photos?colorLabel=  → narrow list by color label             (#184)
 *   PATCH  /v1/photos/:id          → set rating/flag/colorLabel triage      (#141/#149/#184)
 *   DELETE /v1/photos/:id          → soft-delete (sets trashedAt)            (#152)
 *   POST   /v1/photos/:id/restore  → clears trashedAt                        (#152)
 *   POST   /v1/photos/:id/tags     → add/remove tags on a photo              (#173)
 */
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  PhotoNotFoundError,
  TriageValidationError,
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
import {
  isPhotoColorLabel,
  PHOTO_COLOR_LABEL_VALUES,
  type PhotoColorLabel,
} from '../models/Photo.js';

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

/**
 * Parse the `?colorLabel=` query parameter. Accepts a single value
 * (`red|yellow|green|blue|purple`), `uncolored` for null-label rows, or
 * a comma-separated list for OR semantics. Returns `null` when the query
 * is absent or empty. Throws an Error with a human-readable message on
 * invalid values; callers translate to 400.
 */
export function parseColorLabelQuery(
  raw: unknown
):
  | null
  | { kind: 'value'; value: Exclude<PhotoColorLabel, null> }
  | { kind: 'uncolored' }
  | { kind: 'any'; values: Exclude<PhotoColorLabel, null>[] } {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!str) return null;

  const parts = str
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;

  if (parts.length === 1) {
    const only = parts[0];
    if (only === 'uncolored') return { kind: 'uncolored' };
    if (!isPhotoColorLabel(only) || only === null) {
      throw new Error(
        `Invalid colorLabel value: ${only}. Expected one of ${PHOTO_COLOR_LABEL_VALUES.join(
          ', '
        )}, or 'uncolored'.`
      );
    }
    return { kind: 'value', value: only };
  }

  const seen = new Set<string>();
  const values: Exclude<PhotoColorLabel, null>[] = [];
  for (const p of parts) {
    if (p === 'uncolored') {
      throw new Error(
        `colorLabel filter cannot combine 'uncolored' with other values.`
      );
    }
    if (!isPhotoColorLabel(p) || p === null) {
      throw new Error(
        `Invalid colorLabel value: ${p}. Expected one of ${PHOTO_COLOR_LABEL_VALUES.join(
          ', '
        )}.`
      );
    }
    if (!seen.has(p)) {
      seen.add(p);
      values.push(p);
    }
  }
  return { kind: 'any', values };
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
      let colorLabelFilter: ReturnType<typeof parseColorLabelQuery> = null;
      try {
        colorLabelFilter = parseColorLabelQuery(req.query.colorLabel);
      } catch (err) {
        sendError(
          res,
          400,
          'INVALID_FIELD_VALUE',
          err instanceof Error ? err.message : 'invalid colorLabel filter'
        );
        return;
      }
      const baseList = tags.length
        ? await photos.list(callerTenant(req), { trashed, tags })
        : await photos.list(callerTenant(req), { trashed });
      const items = colorLabelFilter
        ? baseList.filter((p) => {
            const filter = colorLabelFilter!;
            const label = p.colorLabel ?? null;
            if (filter.kind === 'uncolored') return label === null;
            if (filter.kind === 'value') {
              return label === filter.value;
            }
            return label !== null && filter.values.includes(label);
          })
        : baseList;
      res.json({
        photos: items.map((p) => ({
          id: p.id,
          libraryId: p.libraryId,
          originalName: p.originalName,
          status: p.status,
          trashedAt: p.trashedAt ?? null,
          trashedBy: p.trashedBy ?? null,
          tags: p.tags ?? [],
          rating: p.rating ?? 0,
          flag: p.flag ?? null,
          colorLabel: p.colorLabel ?? null,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /v1/photos/:id — set rating / flag / colorLabel (issue #184).
  router.patch('/:id', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Only triage fields are accepted here; other PATCHes (tags / favorite)
      // go through dedicated routes for now.
      const patch: {
        rating?: number;
        flag?: unknown;
        colorLabel?: unknown;
      } = {};
      if (Object.prototype.hasOwnProperty.call(body, 'rating')) {
        patch.rating = body.rating as number;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'flag')) {
        patch.flag = body.flag;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'colorLabel')) {
        patch.colorLabel = body.colorLabel;
      }
      if (
        patch.rating === undefined &&
        patch.flag === undefined &&
        patch.colorLabel === undefined
      ) {
        sendError(
          res,
          400,
          'INVALID_FIELD_VALUE',
          'PATCH /v1/photos/:id requires at least one of: rating, flag, colorLabel.'
        );
        return;
      }
      const updated = await photos.updateTriage(
        req.params.id,
        callerTenant(req),
        callerActor(req),
        // updateTriage performs strict per-field validation.
        patch as Parameters<typeof photos.updateTriage>[3]
      );
      res.status(200).json({
        id: updated.id,
        libraryId: updated.libraryId,
        originalName: updated.originalName,
        status: updated.status,
        trashedAt: updated.trashedAt ?? null,
        trashedBy: updated.trashedBy ?? null,
        tags: updated.tags ?? [],
        rating: updated.rating ?? 0,
        flag: updated.flag ?? null,
        colorLabel: updated.colorLabel ?? null,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
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
      if (err instanceof TriageValidationError) {
        sendError(res, 400, err.code, err.message);
        return;
      }
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
