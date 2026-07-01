/**
 * Service layer for per-tenant edit presets (issue #197).
 *
 * Provides the CRUD + apply operations backing the
 * `/v1/tenants/:tenantId/edit-presets` API. Apply reuses the existing
 * edit pipeline via {@link commitPresetToPhoto} — no new processing
 * path is introduced. Per-photo metering emits the existing
 * `edit.applied` event; the batch-level `edit_preset.applied` event
 * (registered in the metering event catalog) is emitted once per apply
 * call by the route handler after this service returns.
 *
 * Multi-tenant enforcement:
 *   - Every write is scoped to `tenantId`; cross-tenant apply photoIds
 *     are rejected wholesale (`CROSS_TENANT_PHOTO_ID`).
 *   - The per-tenant preset cap ({@link EDIT_PRESET_MAX_PER_TENANT}) is
 *     enforced on create.
 */

import { randomUUID } from 'node:crypto';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import {
  EDIT_PRESETS_COLLECTION,
  EDIT_PRESET_MAX_PER_TENANT,
  EDIT_PRESET_NAME_MAX_LENGTH,
  EDIT_PRESET_NAME_MIN_LENGTH,
  editPresetDocId,
  type EditPresetRecipe,
  type EditPresetRecord,
} from '../../models/EditPreset.js';
import type { EditOperation, EditVersion, Photo } from '../../models/Photo.js';
import { DEFAULT_TENANT_ID } from '../../domain/tenant/Tenant.js';
import { validateOperations } from '../edits/EditProcessor.js';
import { EDIT_RECIPE_VERSION } from '../edits/pluginRegistry.js';
import { getEffectiveEnabledPluginIds } from './tenantPluginConfigService.js';
import { emitMeteringEvent } from '../metering/index.js';
import { logger } from '../../utils/logger.js';

/**
 * Thrown by validation helpers when an incoming payload is malformed.
 * The route layer maps this to HTTP `status` with the same `code`.
 */
export class EditPresetValidationError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: Record<string, unknown> | null;
  constructor(
    code: string,
    message: string,
    status = 400,
    details: Record<string, unknown> | null = null
  ) {
    super(message);
    this.name = 'EditPresetValidationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Validate a recipe payload. Returns a normalized recipe. Throws
 * {@link EditPresetValidationError} on any structural or semantic
 * violation. Uses the SAME `validateOperations` implementation as the
 * per-photo `POST /edits/:libraryId/:photoId` handler, so a preset
 * cannot store a recipe the executor would refuse.
 */
export function validateRecipeBody(input: unknown): EditPresetRecipe {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new EditPresetValidationError(
      'INVALID_RECIPE',
      'recipe must be a JSON object'
    );
  }
  const b = input as Record<string, unknown>;

  const recipeVersion =
    typeof b.recipeVersion === 'number' ? b.recipeVersion : EDIT_RECIPE_VERSION;
  if (
    !Number.isInteger(recipeVersion) ||
    recipeVersion !== EDIT_RECIPE_VERSION
  ) {
    throw new EditPresetValidationError(
      'UNSUPPORTED_RECIPE_VERSION',
      `Unsupported recipe version ${recipeVersion}. Supported version: ${EDIT_RECIPE_VERSION}`
    );
  }

  const ops = b.operations;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new EditPresetValidationError(
      'INVALID_RECIPE',
      'recipe.operations must be a non-empty array'
    );
  }
  // Ops must all be objects with `type`, `params`, `order`.
  for (const op of ops) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      throw new EditPresetValidationError(
        'INVALID_RECIPE',
        'each recipe operation must be an object'
      );
    }
    const o = op as Record<string, unknown>;
    if (typeof o.type !== 'string') {
      throw new EditPresetValidationError(
        'INVALID_RECIPE',
        'operation.type must be a string'
      );
    }
    if (typeof o.order !== 'number' || !Number.isInteger(o.order) || o.order < 0) {
      throw new EditPresetValidationError(
        'INVALID_RECIPE',
        'operation.order must be a non-negative integer'
      );
    }
    if (!o.params || typeof o.params !== 'object' || Array.isArray(o.params)) {
      throw new EditPresetValidationError(
        'INVALID_RECIPE',
        'operation.params must be an object'
      );
    }
  }

  const opsValidation = validateOperations(ops as EditOperation[]);
  if (!opsValidation.valid) {
    throw new EditPresetValidationError(
      'INVALID_RECIPE_OPERATIONS',
      `Invalid operations: ${opsValidation.errors.join(', ')}`
    );
  }

  const description =
    typeof b.description === 'string' ? b.description : undefined;

  const normalized: EditPresetRecipe = {
    recipeVersion,
    operations: (ops as EditOperation[]).map((op) => ({
      type: op.type,
      params: { ...op.params },
      order: op.order,
    })),
    ...(description !== undefined ? { description } : {}),
  };
  return normalized;
}

/** Validate the human-readable preset name. */
export function validatePresetName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new EditPresetValidationError(
      'INVALID_PRESET_NAME',
      'name must be a string'
    );
  }
  const trimmed = name.trim();
  if (
    trimmed.length < EDIT_PRESET_NAME_MIN_LENGTH ||
    trimmed.length > EDIT_PRESET_NAME_MAX_LENGTH
  ) {
    throw new EditPresetValidationError(
      'INVALID_PRESET_NAME',
      `name must be between ${EDIT_PRESET_NAME_MIN_LENGTH} and ${EDIT_PRESET_NAME_MAX_LENGTH} characters`
    );
  }
  return trimmed;
}

/**
 * Extract a preset recipe from an existing photo's current edit version.
 * Used when the caller supplies `{ name, fromPhotoId }` instead of an
 * explicit recipe. The photo MUST belong to `tenantId`.
 */
export async function buildRecipeFromPhoto(
  adapter: DataAdapter,
  tenantId: string,
  photoId: string
): Promise<EditPresetRecipe> {
  if (typeof photoId !== 'string' || photoId.length === 0) {
    throw new EditPresetValidationError(
      'INVALID_FROM_PHOTO_ID',
      'fromPhotoId must be a non-empty string'
    );
  }
  const photo = await adapter.fetchData<Photo>('photos', photoId);
  if (!photo) {
    throw new EditPresetValidationError(
      'FROM_PHOTO_NOT_FOUND',
      `Source photo ${photoId} not found`,
      404
    );
  }
  const photoTenant = (photo.tenantId as string | undefined) ?? DEFAULT_TENANT_ID;
  if (photoTenant !== tenantId) {
    throw new EditPresetValidationError(
      'CROSS_TENANT_PHOTO_ID',
      `Source photo ${photoId} belongs to a different tenant`,
      403
    );
  }
  const current = photo.editHistory.find(
    (v) => v.version === photo.currentEditVersion
  );
  if (!current || current.operations.length === 0) {
    throw new EditPresetValidationError(
      'PHOTO_HAS_NO_EDITS',
      `Source photo ${photoId} has no edits to save as a preset`
    );
  }
  return {
    recipeVersion: current.recipeVersion,
    operations: current.operations.map((op) => ({
      type: op.type,
      params: { ...op.params },
      order: op.order,
    })),
    ...(current.description !== undefined
      ? { description: current.description }
      : {}),
  };
}

export interface CreateEditPresetInput {
  tenantId: string;
  name: string;
  recipe: EditPresetRecipe;
  createdBy: string;
}

/**
 * Create a new preset. Enforces the per-tenant cap
 * ({@link EDIT_PRESET_MAX_PER_TENANT}) before insert.
 */
export async function createEditPreset(
  adapter: DataAdapter,
  input: CreateEditPresetInput
): Promise<EditPresetRecord> {
  const existing = await listEditPresets(adapter, input.tenantId);
  if (existing.length >= EDIT_PRESET_MAX_PER_TENANT) {
    throw new EditPresetValidationError(
      'EDIT_PRESET_CAP_EXCEEDED',
      `Tenant has reached the ${EDIT_PRESET_MAX_PER_TENANT}-preset cap`,
      409,
      { cap: EDIT_PRESET_MAX_PER_TENANT, current: existing.length }
    );
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const record: EditPresetRecord = {
    id,
    tenantId: input.tenantId,
    name: input.name,
    recipe: input.recipe,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await adapter.storeData(
    EDIT_PRESETS_COLLECTION,
    editPresetDocId(input.tenantId, id),
    record
  );
  return record;
}

/**
 * Fetch a single preset. Cross-tenant reads return `null` (never a
 * different tenant's data) to avoid leaking the existence of records
 * in other tenants.
 */
export async function getEditPreset(
  adapter: DataAdapter,
  tenantId: string,
  presetId: string
): Promise<EditPresetRecord | null> {
  const doc = await adapter.fetchData<EditPresetRecord>(
    EDIT_PRESETS_COLLECTION,
    editPresetDocId(tenantId, presetId)
  );
  if (!doc) return null;
  if (doc.tenantId !== tenantId) return null;
  return doc;
}

/**
 * List every preset for a tenant, ordered by `createdAt` ascending. The
 * flat key/value adapter is queried by `tenantId` equality; cross-tenant
 * rows are filtered defensively at the service boundary.
 */
export async function listEditPresets(
  adapter: DataAdapter,
  tenantId: string
): Promise<EditPresetRecord[]> {
  const rows = await adapter.queryData<EditPresetRecord>(
    EDIT_PRESETS_COLLECTION,
    [{ field: 'tenantId', operator: '==', value: tenantId }]
  );
  return rows
    .filter((r) => r.tenantId === tenantId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Delete a preset. Returns `true` when a row was removed, `false` when
 * the preset did not exist (so the route can respond 404 vs 200 on the
 * DELETE surface).
 */
export async function deleteEditPreset(
  adapter: DataAdapter,
  tenantId: string,
  presetId: string
): Promise<boolean> {
  const existing = await getEditPreset(adapter, tenantId, presetId);
  if (!existing) return false;
  await adapter.deleteData(
    EDIT_PRESETS_COLLECTION,
    editPresetDocId(tenantId, presetId)
  );
  return true;
}

/** Per-photo apply result surface returned in the batch response. */
export interface ApplyPresetResult {
  photoId: string;
  status: 'applied' | 'skipped' | 'error';
  version?: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface ApplyPresetInput {
  tenantId: string;
  presetId: string;
  photoIds: string[];
  /** User uid or host key id used as `createdBy` on committed edits. */
  actor: string;
}

export interface ApplyPresetOutput {
  presetId: string;
  applied: number;
  failed: number;
  results: ApplyPresetResult[];
}

/**
 * Apply a preset's recipe to every id in `photoIds`. Per-photo failures
 * are captured as `results[i].status === 'error'` so a partial batch
 * still returns HTTP 200 with an actionable per-id status list — this
 * matches the bulk photo ops surface from issue #142.
 *
 * The batch-level cross-tenant pre-check happens in the route layer so
 * a single foreign id rejects the whole request before any commit is
 * attempted; here we defensively re-check per-photo in case a photo
 * was moved between tenants during the batch.
 */
export async function applyEditPreset(
  adapter: DataAdapter,
  input: ApplyPresetInput
): Promise<ApplyPresetOutput> {
  const preset = await getEditPreset(adapter, input.tenantId, input.presetId);
  if (!preset) {
    throw new EditPresetValidationError(
      'EDIT_PRESET_NOT_FOUND',
      `Preset ${input.presetId} not found`,
      404
    );
  }

  const enabledForTenant = await getEffectiveEnabledPluginIds(
    adapter,
    input.tenantId
  );

  const results: ApplyPresetResult[] = [];
  let applied = 0;
  let failed = 0;

  for (const photoId of input.photoIds) {
    try {
      const result = await commitPresetToPhoto(adapter, {
        tenantId: input.tenantId,
        presetId: preset.id,
        recipe: preset.recipe,
        photoId,
        actor: input.actor,
        enabledPluginIds: enabledForTenant,
      });
      results.push(result);
      if (result.status === 'applied') applied += 1;
      else failed += 1;
    } catch (err) {
      logger.warn(
        { err, photoId, presetId: preset.id, tenantId: input.tenantId },
        'apply preset failed for photo'
      );
      results.push({
        photoId,
        status: 'error',
        error: {
          code: 'APPLY_FAILED',
          message: err instanceof Error ? err.message : 'apply failed',
        },
      });
      failed += 1;
    }
  }

  return {
    presetId: preset.id,
    applied,
    failed,
    results,
  };
}

interface CommitPresetInput {
  tenantId: string;
  presetId: string;
  recipe: EditPresetRecipe;
  photoId: string;
  actor: string;
  enabledPluginIds: ReadonlySet<string>;
}

/**
 * Commit a preset's recipe as a new edit version on ONE photo. Mirrors
 * the version-commit path of `handleApplyEdits` so both surfaces produce
 * the same on-disk shape and emit the same per-photo `edit.applied`
 * event. Per-photo failures are returned as `status: 'error'` (not
 * thrown) so a batch can continue.
 */
async function commitPresetToPhoto(
  adapter: DataAdapter,
  input: CommitPresetInput
): Promise<ApplyPresetResult> {
  const photo = await adapter.fetchData<Photo>('photos', input.photoId);
  if (!photo) {
    return {
      photoId: input.photoId,
      status: 'error',
      error: { code: 'PHOTO_NOT_FOUND', message: 'photo not found' },
    };
  }
  const photoTenant =
    (photo.tenantId as string | undefined) ?? DEFAULT_TENANT_ID;
  if (photoTenant !== input.tenantId) {
    // Defensive — the route already rejected the batch, but a photo
    // could theoretically be reassigned mid-flight.
    return {
      photoId: input.photoId,
      status: 'error',
      error: {
        code: 'CROSS_TENANT_PHOTO_ID',
        message: 'photo belongs to a different tenant',
      },
    };
  }

  // Enforce per-tenant plugin allowlist — a preset created before a
  // plugin was disabled must not run the disabled op.
  for (const op of input.recipe.operations) {
    if (!input.enabledPluginIds.has(op.type)) {
      emitMeteringEvent({
        tenantId: input.tenantId,
        type: 'plugin.blocked',
        count: 1,
        resourceId: input.photoId,
        meta: {
          libraryId: photo.libraryId,
          pluginId: op.type,
          userId: input.actor,
          viaPreset: true,
          presetId: input.presetId,
        },
      });
      return {
        photoId: input.photoId,
        status: 'error',
        error: {
          code: 'plugin_disabled_for_tenant',
          message: `Plugin '${op.type}' is disabled for this tenant`,
        },
      };
    }
  }

  const newVersion: EditVersion = {
    version: photo.currentEditVersion + 1,
    recipeVersion: input.recipe.recipeVersion,
    createdAt: new Date().toISOString(),
    createdBy: input.actor,
    operations: input.recipe.operations.map((op) => ({
      type: op.type,
      params: { ...op.params },
      order: op.order,
    })),
    ...(input.recipe.description !== undefined
      ? { description: input.recipe.description }
      : {}),
  };

  const updatedEditHistory = [...photo.editHistory, newVersion];

  await adapter.updateData<Photo>('photos', input.photoId, {
    currentEditVersion: newVersion.version,
    editHistory: updatedEditHistory,
    thumbnailsOutdated: true,
    updatedAt: new Date().toISOString(),
  });

  // Same event shape as the single-photo pipeline so hosts get one
  // consistent stream of `edit.applied` regardless of surface.
  emitMeteringEvent({
    tenantId: input.tenantId,
    type: 'edit.applied',
    count: 1,
    resourceId: input.photoId,
    meta: {
      libraryId: photo.libraryId,
      version: newVersion.version,
      operationCount: newVersion.operations.length,
      viaPreset: true,
      presetId: input.presetId,
    },
  });

  return {
    photoId: input.photoId,
    status: 'applied',
    version: newVersion.version,
  };
}
