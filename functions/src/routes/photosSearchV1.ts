/**
 * Ad-hoc photo search endpoint (issue #207).
 *
 *   POST /v1/photos:search
 *
 * Single composable entrypoint over the existing Photo indexes:
 * filename prefix (`q`), tag AND-set (`tags`), rating range, flag,
 * color label, capturedAt range, camera, trashed. Returns
 * `PhotoSummary[]` in the same shape as `photosListV1` plus a
 * cursor. Tenant scoping is enforced from `req.tenant` /
 * `req.tenantId`; cross-tenant `libraryId` returns 404.
 *
 * Rejects filter combinations that would require an index we don't
 * currently maintain with HTTP 409 `unsupported_query_combination`
 * plus a machine-readable `hint`. There is deliberately no silent
 * client-side filtering fallback for those combos — hosts must
 * see the 409 so they can wait for a follow-up index.
 *
 * v1 is deliberately narrow:
 *   - `q` is a case-insensitive prefix on the denormalized
 *     `filenameLower` field (plus exact tag match).
 *   - No full-text / semantic search.
 *   - No saved queries (that's Smart Albums, #165).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { Photo } from '../models/Photo.js';
import { emitMeteringEvent } from '../services/metering/index.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Base64url-encode a JSON cursor payload. */
function encodeCursor(payload: { offset: number }): string {
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function decodeCursor(raw: string): { offset: number } | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (typeof parsed.offset === 'number' && parsed.offset >= 0) {
      return { offset: parsed.offset };
    }
  } catch {
    // fall through
  }
  return null;
}

const RATING_RANGE = z
  .object({
    gte: z.number().int().min(0).max(5).optional(),
    lte: z.number().int().min(0).max(5).optional(),
  })
  .strict();

const DATE_RANGE = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

export const photosSearchRequestSchema = z
  .object({
    libraryId: z.string().min(1).optional(),
    q: z.string().min(1).max(200).optional(),
    tags: z.array(z.string().min(1).max(64)).max(50).optional(),
    rating: RATING_RANGE.optional(),
    flag: z.enum(['pick', 'reject', 'unflagged']).optional(),
    colorLabel: z
      .enum(['red', 'yellow', 'green', 'blue', 'purple', 'none'])
      .optional(),
    capturedBetween: DATE_RANGE.optional(),
    camera: z.string().min(1).max(200).optional(),
    trashed: z.boolean().optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type PhotosSearchRequest = z.infer<typeof photosSearchRequestSchema>;

/**
 * Determine which query index a request would need. If the caller omits
 * `libraryId` but provides most filters, we currently have no cross-library
 * per-tenant scan — reject with 409 rather than silently fanning out.
 */
function planQuery(req: PhotosSearchRequest): { ok: true } | { ok: false; hint: string } {
  if (!req.libraryId) {
    return {
      ok: false,
      hint:
        "libraryId is required in v1; cross-library search over a tenant is not indexed. " +
        "Pass a libraryId in the body.",
    };
  }
  return { ok: true };
}

function requestedFilterNames(req: PhotosSearchRequest): string[] {
  const names: string[] = [];
  for (const k of [
    'libraryId',
    'q',
    'tags',
    'rating',
    'flag',
    'colorLabel',
    'capturedBetween',
    'camera',
    'trashed',
  ] as const) {
    if (req[k] !== undefined) names.push(k);
  }
  return names;
}

function countFilters(req: PhotosSearchRequest): number {
  // Everything except pagination / libraryId scoping.
  return requestedFilterNames(req).filter(
    (n) => n !== 'libraryId'
  ).length;
}

function normalizedTags(input?: string[]): string[] {
  if (!input) return [];
  return input.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
}

function matchFilename(photo: Photo, q?: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay =
    photo.filenameLower ??
    (typeof photo.originalName === 'string'
      ? photo.originalName.toLowerCase()
      : '');
  if (hay.startsWith(needle)) return true;
  // Also allow tag equality against the same needle so hosts can send a
  // single `q` and match either a filename prefix or a tag exactly.
  const tags = photo.tags ?? [];
  return tags.includes(needle);
}

function matchTags(photo: Photo, wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  const have = new Set((photo.tags ?? []).map((t) => t.toLowerCase()));
  for (const t of wanted) {
    if (!have.has(t)) return false;
  }
  return true;
}

function matchRating(photo: Photo, r?: { gte?: number; lte?: number }): boolean {
  if (!r) return true;
  const v = photo.rating ?? 0;
  if (typeof r.gte === 'number' && v < r.gte) return false;
  if (typeof r.lte === 'number' && v > r.lte) return false;
  return true;
}

function matchFlag(photo: Photo, wanted?: PhotosSearchRequest['flag']): boolean {
  if (!wanted) return true;
  const f = photo.flag ?? null;
  if (wanted === 'unflagged') return f === null;
  return f === wanted;
}

function matchColorLabel(
  photo: Photo,
  wanted?: PhotosSearchRequest['colorLabel']
): boolean {
  if (!wanted) return true;
  const c = photo.colorLabel ?? null;
  if (wanted === 'none') return c === null;
  return c === wanted;
}

function matchCaptured(
  photo: Photo,
  range?: { from?: string; to?: string }
): boolean {
  if (!range) return true;
  const captured =
    photo.exif?.capturedAt || photo.metadata?.takenAt || null;
  if (!captured) return false;
  if (range.from && captured < range.from) return false;
  if (range.to && captured > range.to) return false;
  return true;
}

function matchCamera(photo: Photo, wanted?: string): boolean {
  if (!wanted) return true;
  const needle = wanted.trim().toLowerCase();
  const model = (
    photo.metadata?.cameraModel ??
    photo.exif?.camera ??
    ''
  ).toLowerCase();
  const make = (
    photo.metadata?.cameraMake ??
    ''
  ).toLowerCase();
  return model.includes(needle) || make.includes(needle);
}

function matchTrashed(photo: Photo, wanted?: boolean): boolean {
  const isTrashed = !!photo.trashedAt;
  if (wanted === undefined) {
    // Default: exclude trashed photos, matching photosListV1 behavior.
    return !isTrashed;
  }
  return wanted ? isTrashed : !isTrashed;
}

function photoSummary(p: Photo) {
  return {
    id: p.id,
    libraryId: p.libraryId,
    originalName: p.originalName,
    status: p.status,
    metadata: p.metadata,
    exif: p.exif,
    tags: p.tags ?? [],
    rating: p.rating ?? 0,
    flag: p.flag ?? null,
    colorLabel: p.colorLabel ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function createPhotosSearchV1Router(dataAdapter: DataAdapter): Router {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      if (!req.user && !req.tenant) {
        res.status(401).json({
          error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
        });
        return;
      }

      const parsed = photosSearchRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'INVALID_BODY',
            message: 'Invalid search request',
            details: parsed.error.issues,
          },
        });
        return;
      }
      const body = parsed.data;

      const plan = planQuery(body);
      if (!plan.ok) {
        emitMeteringEvent({
          type: 'photos.search.unsupported',
          tenantId:
            (req as { tenantId?: string }).tenantId ??
            req.tenant?.id ??
            'unknown',
          count: 1,
          ...(body.libraryId ? { resourceId: body.libraryId } : {}),
          occurredAt: new Date().toISOString(),
          meta: { requestedFilters: requestedFilterNames(body) },
        });
        res.status(409).json({
          error: {
            code: 'unsupported_query_combination',
            message: plan.hint,
            hint: plan.hint,
          },
        });
        return;
      }

      const libraryId = body.libraryId as string;

      // Base index: (tenantId?, libraryId). Use the existing photosList
      // pattern — query by libraryId, then apply per-photo predicates.
      const photos = await dataAdapter.queryData<Photo>('photos', [
        { field: 'libraryId', operator: '==', value: libraryId },
      ]);

      // Tenant scoping: cross-tenant libraryId leaks return 404.
      const requesterTenantId =
        (req as { tenantId?: string }).tenantId ??
        req.tenant?.id ??
        (req.user as { tenantId?: string } | undefined)?.tenantId ??
        null;
      const scoped = requesterTenantId
        ? photos.filter(
            (p) => !p.tenantId || p.tenantId === requesterTenantId
          )
        : photos;

      // If nothing exists for this library under the caller's tenant,
      // treat as 404 (do not leak existence of a sibling tenant's
      // library).
      if (photos.length > 0 && scoped.length === 0) {
        res.status(404).json({
          error: {
            code: 'LIBRARY_NOT_FOUND',
            message: 'libraryId not found for this tenant',
          },
        });
        return;
      }

      const wantedTags = normalizedTags(body.tags);
      const filtered = scoped.filter(
        (p) =>
          matchFilename(p, body.q) &&
          matchTags(p, wantedTags) &&
          matchRating(p, body.rating) &&
          matchFlag(p, body.flag) &&
          matchColorLabel(p, body.colorLabel) &&
          matchCaptured(p, body.capturedBetween) &&
          matchCamera(p, body.camera) &&
          matchTrashed(p, body.trashed)
      );

      // Stable sort: newest-first by capturedAt (falling back to createdAt),
      // then id as a tiebreaker so cursor pagination is deterministic.
      const sorted = filtered.sort((a, b) => {
        const av = a.exif?.capturedAt || a.metadata?.takenAt || a.createdAt;
        const bv = b.exif?.capturedAt || b.metadata?.takenAt || b.createdAt;
        if (av !== bv) return av < bv ? 1 : -1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      const limit = body.limit ?? DEFAULT_LIMIT;
      const startOffset = body.cursor
        ? decodeCursor(body.cursor)?.offset ?? 0
        : 0;
      const page = sorted.slice(startOffset, startOffset + limit);
      const nextCursor =
        startOffset + limit < sorted.length
          ? encodeCursor({ offset: startOffset + limit })
          : undefined;

      const items = page.map(photoSummary);

      emitMeteringEvent({
        type: 'photos.searched',
        tenantId: requesterTenantId ?? 'unknown',
        count: 1,
        resourceId: libraryId,
        occurredAt: new Date().toISOString(),
        meta: {
          libraryId,
          resultCount: items.length,
          hasFullText: !!body.q,
          filterCount: countFilters(body),
        },
      });

      res.json({
        items,
        ...(nextCursor ? { nextCursor } : {}),
        totalEstimate: sorted.length,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
