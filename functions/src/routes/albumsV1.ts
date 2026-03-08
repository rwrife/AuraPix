import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { AlbumsService } from '../domain/albums/AlbumsService.js';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

type SortBy = 'createdAt' | 'updatedAt' | 'name';
type SortOrder = 'asc' | 'desc';

function sendError(
  res: { status: (code: number) => { json: (payload: unknown) => void } },
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> | null = null
): void {
  const requestId = randomUUID();
  res.status(status).json({
    error: {
      code,
      message,
      requestId,
      details,
    },
  });
}

function parsePositiveInt(value: unknown, fallback: number, key: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

export function createAlbumsV1Router(albums: AlbumsService): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }

      const page = parsePositiveInt(req.query.page, DEFAULT_PAGE, 'page');
      const pageSize = Math.min(
        parsePositiveInt(req.query.pageSize, DEFAULT_PAGE_SIZE, 'pageSize'),
        MAX_PAGE_SIZE
      );

      const sortBy = (typeof req.query.sortBy === 'string' ? req.query.sortBy : 'updatedAt') as SortBy;
      const sortOrder = (typeof req.query.sortOrder === 'string' ? req.query.sortOrder : 'desc') as SortOrder;
      const nameContains =
        typeof req.query.nameContains === 'string' && req.query.nameContains.trim()
          ? req.query.nameContains.trim().toLowerCase()
          : null;

      if (!['createdAt', 'updatedAt', 'name'].includes(sortBy)) {
        sendError(res, 400, 'INVALID_QUERY', 'sortBy must be one of createdAt, updatedAt, name');
        return;
      }

      if (!['asc', 'desc'].includes(sortOrder)) {
        sendError(res, 400, 'INVALID_QUERY', 'sortOrder must be one of asc, desc');
        return;
      }

      let items = await albums.list(req.user.uid);

      if (nameContains) {
        items = items.filter((item) => item.title.toLowerCase().includes(nameContains));
      }

      items.sort((a, b) => {
        let left: string;
        let right: string;

        if (sortBy === 'name') {
          left = a.title.toLowerCase();
          right = b.title.toLowerCase();
        } else {
          left = a[sortBy];
          right = b[sortBy];
        }

        const compare = left.localeCompare(right);
        return sortOrder === 'asc' ? compare : -compare;
      });

      const total = items.length;
      const start = (page - 1) * pageSize;
      const paged = items.slice(start, start + pageSize);

      res.json({
        albums: paged.map((album) => ({
          id: album.id,
          name: album.title,
          description: album.description ?? null,
          folderId: null,
          photoIds: [],
          createdAt: album.createdAt,
          updatedAt: album.updatedAt,
        })),
        pagination: {
          page,
          pageSize,
          total,
          hasNextPage: start + pageSize < total,
          sortBy,
          sortOrder,
          filters: {
            nameContains,
          },
        },
      });
    } catch (error) {
      if (error instanceof Error && /positive integer/.test(error.message)) {
        sendError(res, 400, 'INVALID_QUERY', error.message);
        return;
      }
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      if (!req.user) {
        sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
        return;
      }

      const name =
        typeof req.body?.name === 'string'
          ? req.body.name
          : typeof req.body?.title === 'string'
            ? req.body.title
            : '';

      if (!name.trim()) {
        sendError(res, 400, 'INVALID_BODY', 'name is required');
        return;
      }

      const created = await albums.create({
        ownerId: req.user.uid,
        title: name,
        description: typeof req.body?.description === 'string' ? req.body.description : undefined,
      });

      res.status(201).json({
        album: {
          id: created.id,
          name: created.title,
          description: created.description ?? null,
          folderId: null,
          photoIds: [],
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'album-title-required') {
        sendError(res, 400, 'INVALID_BODY', 'name is required');
        return;
      }

      next(error);
    }
  });

  return router;
}
