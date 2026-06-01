/**
 * Photo list endpoint (v1).
 *
 * Adds `?sort=capturedAt` / `?sort=-capturedAt` (issue #151) with a graceful
 * fallback to `createdAt` (upload time) when a photo has no EXIF capture date.
 */
import { Router } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { Photo } from '../models/Photo.js';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type SortKey = 'capturedAt' | 'createdAt' | 'updatedAt';

function parseSort(raw: unknown): { key: SortKey; order: 'asc' | 'desc' } {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : '-createdAt';
  const order: 'asc' | 'desc' = value.startsWith('-') ? 'desc' : 'asc';
  const keyRaw = value.replace(/^[+-]/, '');
  const allowed: SortKey[] = ['capturedAt', 'createdAt', 'updatedAt'];
  if (!(allowed as string[]).includes(keyRaw)) {
    throw new Error(
      `sort must be one of capturedAt, createdAt, updatedAt (optionally prefixed with '-')`
    );
  }
  return { key: keyRaw as SortKey, order };
}

function parsePositiveInt(value: unknown, fallback: number, key: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

/**
 * Resolve the sort value for a photo. Falls back to `createdAt` (upload time)
 * when `capturedAt` is requested but missing — preserves stable ordering for
 * photos imported without EXIF dates.
 */
function sortValue(photo: Photo, key: SortKey): string {
  if (key === 'capturedAt') {
    return photo.exif?.capturedAt || photo.metadata?.takenAt || photo.createdAt;
  }
  return key === 'updatedAt' ? photo.updatedAt : photo.createdAt;
}

export function createPhotosV1Router(dataAdapter: DataAdapter): Router {
  const router = Router();

  /**
   * GET /api/v1/photos?libraryId=...&sort=capturedAt|-capturedAt
   */
  router.get('/', async (req, res, next) => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
        });
        return;
      }

      const libraryId =
        typeof req.query.libraryId === 'string' ? req.query.libraryId.trim() : '';
      if (!libraryId) {
        res.status(400).json({
          error: {
            code: 'INVALID_QUERY',
            message: 'libraryId query parameter is required',
          },
        });
        return;
      }

      let sort: { key: SortKey; order: 'asc' | 'desc' };
      let page: number;
      let pageSize: number;
      try {
        sort = parseSort(req.query.sort);
        page = parsePositiveInt(req.query.page, DEFAULT_PAGE, 'page');
        pageSize = Math.min(
          parsePositiveInt(req.query.pageSize, DEFAULT_PAGE_SIZE, 'pageSize'),
          MAX_PAGE_SIZE
        );
      } catch (err) {
        res.status(400).json({
          error: {
            code: 'INVALID_QUERY',
            message: err instanceof Error ? err.message : 'Invalid query',
          },
        });
        return;
      }

      const photos = await dataAdapter.queryData<Photo>('photos', [
        { field: 'libraryId', operator: '==', value: libraryId },
      ]);

      // Tenant scoping: never leak photos across tenants. If the request has a
      // resolved tenantId, filter; otherwise rely on the underlying adapter's
      // own scoping (LocalJsonData / Firestore).
      const requesterTenantId = (req.user as { tenantId?: string }).tenantId;
      const scoped = requesterTenantId
        ? photos.filter(
            (p) => !p.tenantId || p.tenantId === requesterTenantId
          )
        : photos;

      const sorted = [...scoped].sort((a, b) => {
        const left = sortValue(a, sort.key);
        const right = sortValue(b, sort.key);
        const cmp = left < right ? -1 : left > right ? 1 : 0;
        return sort.order === 'asc' ? cmp : -cmp;
      });

      const total = sorted.length;
      const start = (page - 1) * pageSize;
      const paged = sorted.slice(start, start + pageSize);

      res.json({
        photos: paged.map((p) => ({
          id: p.id,
          libraryId: p.libraryId,
          originalName: p.originalName,
          status: p.status,
          metadata: p.metadata,
          exif: p.exif,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
        pagination: {
          page,
          pageSize,
          total,
          hasNextPage: start + pageSize < total,
          sort: `${sort.order === 'desc' ? '-' : ''}${sort.key}`,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
