/**
 * Per-tenant edit-preset endpoints (issue #197).
 *
 * Lightroom-style "develop presets" — save the edit recipe of one photo
 * and apply it across a selection. Mounted at
 * `/v1/tenants/:tenantId/edit-presets` (and mirrored under `/api/v1/...`).
 *
 *   POST   /:tenantId/edit-presets                     → editor+ or host key (write)
 *   GET    /:tenantId/edit-presets                     → viewer+ or host key (read)
 *   DELETE /:tenantId/edit-presets/:presetId           → editor+ or host key (write)
 *   POST   /:tenantId/edit-presets/:presetId/apply     → editor+ or host key (write)
 *                                                        Idempotency-Key supported
 *
 * Auth shape mirrors `tenantExportPresetsV1.ts` — either a host API key
 * carrying the appropriate scope OR an authenticated Firebase user
 * (whose tenant-member role is validated against a configurable role
 * check). Cross-tenant photoIds in an apply batch reject the whole
 * request with HTTP 400.
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { TenantApiKeyScope } from '../models/TenantApiKey.js';
import { DEFAULT_TENANT_ID } from '../domain/tenant/Tenant.js';
import {
  EDIT_PRESET_APPLY_MAX_PHOTO_IDS,
  EDIT_PRESET_NAME_MAX_LENGTH,
  EDIT_PRESET_NAME_MIN_LENGTH,
  type EditPresetRecord,
} from '../models/EditPreset.js';
import type { Photo } from '../models/Photo.js';
import {
  EditPresetValidationError,
  applyEditPreset,
  buildRecipeFromPhoto,
  createEditPreset,
  deleteEditPreset,
  getEditPreset,
  listEditPresets,
  validatePresetName,
  validateRecipeBody,
} from '../services/host/editPresetService.js';
import { emitMeteringEvent } from '../services/metering/index.js';

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
 * Resolve the tenant-member role of `req.user` inside `tenantId`.
 * Injected as a router dep so unit tests can bypass the adapter, and so
 * the production wiring can substitute the real
 * `tenantMembershipService.getMembership` without pulling that module
 * into every test harness.
 *
 * Returns `null` when the user is not a member of the tenant.
 */
export type TenantRoleResolver = (
  tenantId: string,
  userId: string
) => Promise<'owner' | 'editor' | 'viewer' | null>;

/** Roles allowed to write / apply presets. */
const WRITE_ROLES: ReadonlySet<'owner' | 'editor' | 'viewer'> = new Set([
  'owner',
  'editor',
]);

/** Roles allowed to read presets. */
const READ_ROLES: ReadonlySet<'owner' | 'editor' | 'viewer'> = new Set([
  'owner',
  'editor',
  'viewer',
]);

/**
 * Guard factory: accept either a host API key with the given scope OR
 * a Firebase user whose tenant-member role is in `allowedRoles`.
 * Cross-tenant host keys and non-members are rejected here.
 */
function requireUserRoleOrHostKey(
  scope: TenantApiKeyScope,
  allowedRoles: ReadonlySet<'owner' | 'editor' | 'viewer'>,
  roleResolver: TenantRoleResolver
) {
  return async function guard(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const tenantId = String(req.params.tenantId ?? '');
    if (!tenantId) {
      sendError(res, 400, 'VALIDATION_ERROR', 'tenantId is required');
      return;
    }
    if (req.tenant) {
      if (req.tenant.id !== tenantId) {
        sendError(
          res,
          403,
          'CROSS_TENANT_FORBIDDEN',
          'Cross-tenant request rejected'
        );
        return;
      }
      if (!new Set(req.tenant.scopes).has(scope)) {
        sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Insufficient scope', {
          missing: [scope],
        });
        return;
      }
      next();
      return;
    }
    if (req.user) {
      let role: 'owner' | 'editor' | 'viewer' | null;
      try {
        role = await roleResolver(tenantId, req.user.uid);
      } catch (err) {
        sendError(
          res,
          500,
          'ROLE_RESOLUTION_FAILED',
          err instanceof Error ? err.message : 'role resolution failed'
        );
        return;
      }
      if (role === null) {
        sendError(
          res,
          403,
          'NOT_A_TENANT_MEMBER',
          'Authenticated user is not a member of this tenant'
        );
        return;
      }
      if (!allowedRoles.has(role)) {
        sendError(res, 403, 'INSUFFICIENT_ROLE', 'Insufficient tenant role', {
          role,
          required: [...allowedRoles],
        });
        return;
      }
      next();
      return;
    }
    sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required');
  };
}

/** Body schema for `POST /edit-presets` — recipe form. */
const CreateFromRecipeSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(EDIT_PRESET_NAME_MIN_LENGTH)
      .max(EDIT_PRESET_NAME_MAX_LENGTH),
    recipe: z.object({
      recipeVersion: z.number().int().optional(),
      operations: z
        .array(
          z.object({
            type: z.string(),
            params: z.record(z.unknown()),
            order: z.number().int().min(0),
          })
        )
        .min(1),
      description: z.string().optional(),
    }),
  })
  .strict();

/** Body schema for `POST /edit-presets` — copy-from-photo form. */
const CreateFromPhotoSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(EDIT_PRESET_NAME_MIN_LENGTH)
      .max(EDIT_PRESET_NAME_MAX_LENGTH),
    fromPhotoId: z.string().min(1),
  })
  .strict();

/** Body schema for `POST /edit-presets/:presetId/apply`. */
const ApplyBodySchema = z
  .object({
    photoIds: z
      .array(z.string().min(1))
      .min(1)
      .max(EDIT_PRESET_APPLY_MAX_PHOTO_IDS),
  })
  .strict();

/** Wire-shape returned to callers. Strips internal-only fields. */
function serializePreset(record: EditPresetRecord): Record<string, unknown> {
  return {
    id: record.id,
    tenantId: record.tenantId,
    name: record.name,
    recipe: record.recipe,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface TenantEditPresetsRouterDeps {
  dataAdapter: DataAdapter;
  /**
   * Resolve a user's tenant-member role. Defaults to a permissive
   * "editor" role so callers that mount the router without a role
   * source (legacy single-tenant-per-user mode) still work — matches
   * the convention used in `tenantUsage.ts`.
   */
  resolveTenantRole?: TenantRoleResolver;
}

export function createTenantEditPresetsRouter(
  deps: TenantEditPresetsRouterDeps
): Router {
  const router = Router({ mergeParams: true });
  const resolveTenantRole: TenantRoleResolver =
    deps.resolveTenantRole ?? (async () => 'editor');

  // POST /:tenantId/edit-presets
  router.post(
    '/:tenantId/edit-presets',
    requireUserRoleOrHostKey(
      'edit-presets.write',
      WRITE_ROLES,
      resolveTenantRole
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const body = req.body as Record<string, unknown> | undefined;
        if (!body || typeof body !== 'object') {
          sendError(res, 400, 'INVALID_REQUEST_BODY', 'Body must be an object');
          return;
        }
        const actor = req.tenant?.keyId ?? req.user?.uid ?? 'unknown';
        let name: string;
        let recipe;
        try {
          if ('fromPhotoId' in body) {
            const parsed = CreateFromPhotoSchema.safeParse(body);
            if (!parsed.success) {
              sendError(
                res,
                400,
                'INVALID_REQUEST_BODY',
                parsed.error.errors
                  .map((e) => `${e.path.join('.')}: ${e.message}`)
                  .join(', ')
              );
              return;
            }
            name = validatePresetName(parsed.data.name);
            recipe = await buildRecipeFromPhoto(
              deps.dataAdapter,
              tenantId,
              parsed.data.fromPhotoId
            );
          } else {
            const parsed = CreateFromRecipeSchema.safeParse(body);
            if (!parsed.success) {
              sendError(
                res,
                400,
                'INVALID_REQUEST_BODY',
                parsed.error.errors
                  .map((e) => `${e.path.join('.')}: ${e.message}`)
                  .join(', ')
              );
              return;
            }
            name = validatePresetName(parsed.data.name);
            recipe = validateRecipeBody(parsed.data.recipe);
          }
        } catch (err) {
          if (err instanceof EditPresetValidationError) {
            sendError(res, err.status, err.code, err.message, err.details);
            return;
          }
          throw err;
        }
        const record = await createEditPreset(deps.dataAdapter, {
          tenantId,
          name,
          recipe,
          createdBy: actor,
        });
        res.status(201).json(serializePreset(record));
      } catch (err) {
        if (err instanceof EditPresetValidationError) {
          sendError(res, err.status, err.code, err.message, err.details);
          return;
        }
        next(err);
      }
    }
  );

  // GET /:tenantId/edit-presets
  router.get(
    '/:tenantId/edit-presets',
    requireUserRoleOrHostKey(
      'edit-presets.read',
      READ_ROLES,
      resolveTenantRole
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const presets = await listEditPresets(deps.dataAdapter, tenantId);
        res.json({
          tenantId,
          presets: presets.map(serializePreset),
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // DELETE /:tenantId/edit-presets/:presetId
  router.delete(
    '/:tenantId/edit-presets/:presetId',
    requireUserRoleOrHostKey(
      'edit-presets.write',
      WRITE_ROLES,
      resolveTenantRole
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const presetId = String(req.params.presetId);
        const removed = await deleteEditPreset(
          deps.dataAdapter,
          tenantId,
          presetId
        );
        if (!removed) {
          sendError(
            res,
            404,
            'EDIT_PRESET_NOT_FOUND',
            `Preset ${presetId} not found`
          );
          return;
        }
        res.json({ tenantId, id: presetId, removed: true });
      } catch (err) {
        next(err);
      }
    }
  );

  // POST /:tenantId/edit-presets/:presetId/apply
  router.post(
    '/:tenantId/edit-presets/:presetId/apply',
    requireUserRoleOrHostKey(
      'edit-presets.write',
      WRITE_ROLES,
      resolveTenantRole
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId);
        const presetId = String(req.params.presetId);
        const parsed = ApplyBodySchema.safeParse(req.body);
        if (!parsed.success) {
          sendError(
            res,
            400,
            'INVALID_REQUEST_BODY',
            parsed.error.errors
              .map((e) => `${e.path.join('.')}: ${e.message}`)
              .join(', ')
          );
          return;
        }
        const photoIds = parsed.data.photoIds;

        // Preset must exist (fast fail — before cross-tenant checks).
        const preset = await getEditPreset(
          deps.dataAdapter,
          tenantId,
          presetId
        );
        if (!preset) {
          sendError(
            res,
            404,
            'EDIT_PRESET_NOT_FOUND',
            `Preset ${presetId} not found`
          );
          return;
        }

        // Batch-level cross-tenant pre-check. ANY foreign id fails the
        // whole batch, mirroring the bulk photo ops surface (#142).
        const unique = Array.from(new Set(photoIds));
        for (const photoId of unique) {
          const photo = await deps.dataAdapter.fetchData<Photo>(
            'photos',
            photoId
          );
          if (photo === null) continue; // per-photo NOT_FOUND handled below
          const photoTenant =
            (photo.tenantId as string | undefined) ?? DEFAULT_TENANT_ID;
          if (photoTenant !== tenantId) {
            sendError(
              res,
              400,
              'CROSS_TENANT_PHOTO_ID',
              'photoIds contains an id owned by a different tenant',
              { photoId }
            );
            return;
          }
        }

        const actor = req.tenant?.keyId ?? req.user?.uid ?? 'unknown';
        const outcome = await applyEditPreset(deps.dataAdapter, {
          tenantId,
          presetId,
          photoIds,
          actor,
        });

        // One batch-level metering event per apply call. Per-photo
        // `edit.applied` events are emitted inside `applyEditPreset`.
        emitMeteringEvent({
          tenantId,
          type: 'edit_preset.applied',
          count: 1,
          resourceId: presetId,
          meta: {
            presetId,
            photoCount: photoIds.length,
            succeeded: outcome.applied,
            failed: outcome.failed,
          },
        });

        res.status(200).json({
          presetId: outcome.presetId,
          requested: photoIds.length,
          applied: outcome.applied,
          failed: outcome.failed,
          results: outcome.results,
        });
      } catch (err) {
        if (err instanceof EditPresetValidationError) {
          sendError(res, err.status, err.code, err.message, err.details);
          return;
        }
        next(err);
      }
    }
  );

  return router;
}
