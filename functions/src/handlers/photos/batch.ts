/**
 * Bulk photo operations endpoint.
 *
 * POST /api/v1/photos:batch
 * {
 *   action: "move" | "delete" | "addTag" | "removeTag",
 *   photoIds: [...],
 *   params?: { albumId?: string, tag?: string }
 * }
 *
 * Implements issue #142:
 *   - Cap N (configurable via BULK_PHOTOS_BATCH_MAX, default 200), oversize -> 413
 *   - Per-id result array; partial failures do not abort the batch
 *   - Cross-tenant id -> entire batch rejected with 400 cross_tenant_reference
 *   - Per-tenant sliding-window rate limit (default 10/sec, configurable)
 *   - Each affected photo still emits its existing per-photo audit event;
 *     additionally one `bulk.batch` metering event per call.
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import {
  DEFAULT_TENANT_ID,
  type TenantId,
} from '../../domain/tenant/Tenant.js';
import { recordAuditEvent } from '../../services/audit/AuditService.js';
import { emitMeteringEvent } from '../../services/metering/index.js';
import { logger } from '../../utils/logger.js';

export type BulkAction = 'move' | 'delete' | 'addTag' | 'removeTag';

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  'move',
  'delete',
  'addTag',
  'removeTag',
]);

export interface BulkRequestBody {
  action: BulkAction;
  photoIds: string[];
  params?: {
    albumId?: string;
    tag?: string;
  };
}

export interface BulkResultItem {
  id: string;
  ok: boolean;
  error?: string;
}

export interface BulkResponseBody {
  action: BulkAction;
  requested: number;
  succeeded: number;
  failed: number;
  results: BulkResultItem[];
}

/**
 * Read the configured cap for bulk operations.
 * Defaults to 200. Configurable via BULK_PHOTOS_BATCH_MAX.
 */
export function getBulkBatchMax(): number {
  const raw = process.env.BULK_PHOTOS_BATCH_MAX;
  if (!raw) return 200;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 200;
  return parsed;
}

/**
 * Read the configured per-tenant batch rate limit (calls / second).
 * Defaults to 10. Configurable via BULK_PHOTOS_RATE_LIMIT_PER_SEC.
 */
export function getBulkBatchRateLimitPerSec(): number {
  const raw = process.env.BULK_PHOTOS_RATE_LIMIT_PER_SEC;
  if (!raw) return 10;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 10;
  return parsed;
}

// --- Per-tenant sliding-window rate limiter (1 second window) ---

const tenantBuckets = new Map<TenantId, number[]>();

export function clearBulkBatchRateLimiter(): void {
  tenantBuckets.clear();
}

function checkTenantRate(tenantId: TenantId): {
  ok: boolean;
  retryAfterSec: number;
} {
  const limit = getBulkBatchRateLimitPerSec();
  const windowMs = 1000;
  const now = Date.now();
  const timestamps = (tenantBuckets.get(tenantId) ?? []).filter(
    (t) => now - t < windowMs
  );
  if (timestamps.length >= limit) {
    const oldest = timestamps[0] ?? now;
    const retryAfterSec = Math.max(
      1,
      Math.ceil((windowMs - (now - oldest)) / 1000)
    );
    tenantBuckets.set(tenantId, timestamps);
    return { ok: false, retryAfterSec };
  }
  timestamps.push(now);
  tenantBuckets.set(tenantId, timestamps);
  return { ok: true, retryAfterSec: 0 };
}

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

/**
 * Validate the request body. Returns the parsed body or an error tuple.
 */
function parseBody(
  body: unknown
):
  | { ok: true; value: BulkRequestBody }
  | { ok: false; status: number; code: string; message: string } {
  if (!body || typeof body !== 'object') {
    return {
      ok: false,
      status: 400,
      code: 'invalid_request',
      message: 'Request body must be a JSON object',
    };
  }
  const b = body as Record<string, unknown>;
  const action = b.action;
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_action',
      message: `action must be one of: ${Array.from(VALID_ACTIONS).join(', ')}`,
    };
  }
  const photoIds = b.photoIds;
  if (!Array.isArray(photoIds) || photoIds.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_request',
      message: 'photoIds must be a non-empty array',
    };
  }
  if (!photoIds.every((id) => typeof id === 'string' && id.length > 0)) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_request',
      message: 'photoIds must contain only non-empty strings',
    };
  }
  const params =
    b.params && typeof b.params === 'object'
      ? (b.params as { albumId?: string; tag?: string })
      : undefined;

  // Action-specific param validation.
  if (action === 'move') {
    if (!params || typeof params.albumId !== 'string' || !params.albumId) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_params',
        message: 'params.albumId is required for action="move"',
      };
    }
  }
  if (action === 'addTag' || action === 'removeTag') {
    if (!params || typeof params.tag !== 'string' || !params.tag) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_params',
        message: `params.tag is required for action="${action}"`,
      };
    }
  }

  return {
    ok: true,
    value: {
      action: action as BulkAction,
      photoIds: photoIds as string[],
      params,
    },
  };
}

/**
 * Apply a single action to one photo doc. The DataAdapter abstraction is
 * not transactional across documents; tests cover correctness per-item and
 * production Firestore implementations may swap in a BatchedWrite later.
 */
async function applyToPhoto(
  dataAdapter: DataAdapter,
  libraryId: string,
  photoId: string,
  action: BulkAction,
  params: BulkRequestBody['params']
): Promise<void> {
  switch (action) {
    case 'delete': {
      await dataAdapter.deleteData('photos', photoId);
      return;
    }
    case 'move': {
      await dataAdapter.updateData('photos', photoId, {
        albumId: params?.albumId,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    case 'addTag': {
      const photo = (await dataAdapter.getPhoto(libraryId, photoId)) as
        | { tags?: string[] }
        | null;
      const tag = params!.tag!;
      const tags = Array.isArray(photo?.tags) ? photo!.tags! : [];
      if (!tags.includes(tag)) {
        await dataAdapter.updateData('photos', photoId, {
          tags: [...tags, tag],
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }
    case 'removeTag': {
      const photo = (await dataAdapter.getPhoto(libraryId, photoId)) as
        | { tags?: string[] }
        | null;
      const tag = params!.tag!;
      const tags = Array.isArray(photo?.tags) ? photo!.tags! : [];
      if (tags.includes(tag)) {
        await dataAdapter.updateData('photos', photoId, {
          tags: tags.filter((t) => t !== tag),
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }
  }
}

function auditTypeFor(action: BulkAction): string {
  switch (action) {
    case 'delete':
      return 'photo.deleted';
    case 'move':
      return 'photo.moved';
    case 'addTag':
      return 'photo.tag.added';
    case 'removeTag':
      return 'photo.tag.removed';
  }
}

/**
 * Express handler factory. The handler is dependency-injected with the
 * DataAdapter and a tenant resolver.
 *
 * tenantOfPhoto: returns the tenantId stored on the photo doc (or null when
 * the doc is missing). Defaults to looking up via getPhoto and treating a
 * missing `tenantId` field as DEFAULT_TENANT_ID (legacy data).
 */
export function createBulkPhotosHandler(deps: {
  dataAdapter: DataAdapter;
  tenantOfPhoto?: (photoId: string) => Promise<TenantId | null>;
}) {
  const tenantOfPhoto =
    deps.tenantOfPhoto ??
    (async (photoId: string): Promise<TenantId | null> => {
      const doc = (await deps.dataAdapter.fetchData<{
        tenantId?: string;
      }>('photos', photoId)) as { tenantId?: string } | null;
      if (!doc) return null;
      return (doc.tenantId as TenantId) ?? DEFAULT_TENANT_ID;
    });

  return async function handleBulkPhotos(
    req: Request,
    res: Response
  ): Promise<void> {
    const userId = req.user?.uid;
    if (!userId) {
      sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
      return;
    }

    const callerTenant: TenantId = req.tenantId ?? DEFAULT_TENANT_ID;

    // 1. Per-tenant rate limit.
    const rate = checkTenantRate(callerTenant);
    if (!rate.ok) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      sendError(
        res,
        429,
        'RATE_LIMIT_EXCEEDED',
        `Too many batch calls for tenant. Try again in ${rate.retryAfterSec}s.`
      );
      return;
    }

    // 2. Body validation.
    const parsed = parseBody(req.body);
    if (!parsed.ok) {
      sendError(res, parsed.status, parsed.code, parsed.message);
      return;
    }
    const { action, photoIds, params } = parsed.value;

    // 3. Cap.
    const cap = getBulkBatchMax();
    if (photoIds.length > cap) {
      sendError(res, 413, 'batch_too_large', `photoIds exceeds cap of ${cap}`, {
        cap,
        received: photoIds.length,
      });
      return;
    }

    // 4. Cross-tenant pre-check: ANY foreign id rejects the whole batch.
    //    Resolves tenantId for each unique photoId.
    const unique = Array.from(new Set(photoIds));
    let foreign: string | null = null;
    const tenantMap = new Map<string, TenantId | null>();
    for (const id of unique) {
      const t = await tenantOfPhoto(id);
      tenantMap.set(id, t);
      if (t !== null && t !== callerTenant) {
        foreign = id;
        break;
      }
    }
    if (foreign) {
      sendError(
        res,
        400,
        'cross_tenant_reference',
        'photoIds contains an id owned by a different tenant',
        { photoId: foreign }
      );
      return;
    }

    // 5. Resolve libraryId from params or query (handlers historically
    //    use libraryId scoping; the bulk endpoint accepts it on params).
    const libraryId =
      (params && typeof (params as { libraryId?: string }).libraryId === 'string'
        ? (params as { libraryId?: string }).libraryId!
        : typeof req.query.libraryId === 'string'
          ? req.query.libraryId
          : '') || '';

    // 6. Apply per id; collect results. Partial failures do not abort.
    const results: BulkResultItem[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const id of photoIds) {
      // Skip ids that resolved to a non-existent photo (404-ish).
      const t = tenantMap.get(id);
      if (t === null) {
        results.push({ id, ok: false, error: 'not_found' });
        failed += 1;
        continue;
      }
      try {
        await applyToPhoto(deps.dataAdapter, libraryId, id, action, params);
        // Per-photo existing audit event (do NOT collapse).
        await recordAuditEvent(deps.dataAdapter, {
          eventType: auditTypeFor(action),
          actorId: userId,
          targetId: id,
          metadata: {
            tenantId: callerTenant,
            action,
            params: params ?? null,
            viaBulk: true,
          },
        }).catch((err) => {
          // Audit failure should not fail the operation.
          logger.warn({ err, photoId: id, action }, 'audit emit failed');
        });
        results.push({ id, ok: true });
        succeeded += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'error';
        logger.warn({ err, photoId: id, action }, 'bulk item failed');
        results.push({ id, ok: false, error: msg });
        failed += 1;
      }
    }

    // 7. Single bulk.batch metering event per call.
    emitMeteringEvent({
      tenantId: callerTenant,
      type: 'bulk.batch',
      count: 1,
      meta: {
        action,
        requested: photoIds.length,
        succeeded,
        failed,
      },
    });

    const body: BulkResponseBody = {
      action,
      requested: photoIds.length,
      succeeded,
      failed,
      results,
    };
    res.status(200).json(body);
  };
}
