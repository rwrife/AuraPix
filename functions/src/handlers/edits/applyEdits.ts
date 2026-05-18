import type { Request, Response } from 'express';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { Photo, EditVersion } from '../../models/Photo.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { ApplyEditsSchema } from '../../utils/validation.js';
import { validateOperations } from '../../services/edits/EditProcessor.js';
import { EDIT_RECIPE_VERSION, listPlugins } from '../../services/edits/pluginRegistry.js';
import {
  createApplyEditsFingerprint,
  createRevertFingerprint,
  editFingerprintMatches,
  getEditIdempotencyRecord,
  getNormalizedIdempotencyKey,
  storeEditIdempotencyRecord,
} from './editIdempotency.js';
import {
  emitMeteringEvent,
  resolveTenantId,
} from '../../services/metering/index.js';

function parseExpectedCurrentVersion(headerValue: string | undefined): number | null {
  if (!headerValue) return null;

  const parsed = Number.parseInt(headerValue, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError(
      400,
      'INVALID_IF_MATCH_EDIT_VERSION',
      'If-Match-Edit-Version must be a non-negative integer'
    );
  }

  return parsed;
}

function assertEditVersionMatch(
  expectedCurrentVersion: number | null,
  actualCurrentVersion: number
): void {
  if (expectedCurrentVersion === null) return;

  if (expectedCurrentVersion !== actualCurrentVersion) {
    throw new AppError(
      409,
      'EDIT_VERSION_CONFLICT',
      `Edit version conflict: expected current version ${expectedCurrentVersion}, actual version ${actualCurrentVersion}`
    );
  }
}


/**
 * List edit plugins and recipe contract version
 * GET /edits/plugins
 */
export async function handleListPlugins(
  _req: Request,
  res: Response
): Promise<void> {
  res.json({
    recipeVersion: EDIT_RECIPE_VERSION,
    plugins: listPlugins(),
  });
}

/**
 * Apply edits to a photo
 * POST /images/:libraryId/:photoId/edits
 */
export async function handleApplyEdits(
  req: Request,
  res: Response
): Promise<void> {
  const dataAdapter = req.app.locals.dataAdapter as DataAdapter;
  const storageAdapter = req.app.locals.storageAdapter as StorageAdapter;

  const libraryId = req.params.libraryId as string;
  const photoId = req.params.photoId as string;
  const userId = req.user?.uid || 'anonymous';
  const expectedCurrentVersion = parseExpectedCurrentVersion(
    req.header('If-Match-Edit-Version') ?? undefined
  );

  let idempotencyKey: string | null;
  try {
    idempotencyKey = getNormalizedIdempotencyKey(req.header('Idempotency-Key'));
  } catch (error) {
    throw new AppError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      error instanceof Error ? error.message : 'Invalid idempotency key'
    );
  }

  // Validate request body
  const validation = ApplyEditsSchema.safeParse(req.body);
  if (!validation.success) {
    throw new AppError(400, 'INVALID_REQUEST', `Invalid request: ${validation.error.message}`);
  }

  const { recipeVersion, operations, description } = validation.data;

  if (recipeVersion !== EDIT_RECIPE_VERSION) {
    throw new AppError(
      400,
      'UNSUPPORTED_RECIPE_VERSION',
      `Unsupported recipe version ${recipeVersion}. Supported version: ${EDIT_RECIPE_VERSION}`
    );
  }

  // Validate operations
  const opsValidation = validateOperations(operations);
  if (!opsValidation.valid) {
    throw new AppError(400, 'INVALID_OPERATIONS', `Invalid operations: ${opsValidation.errors.join(', ')}`);
  }

  const requestFingerprint = createApplyEditsFingerprint({
    recipeVersion,
    operations,
    description,
  });

  if (idempotencyKey) {
    const existingRecord = await getEditIdempotencyRecord(
      dataAdapter,
      userId,
      libraryId,
      photoId,
      idempotencyKey
    );

    if (existingRecord) {
      if (!editFingerprintMatches(existingRecord.request, requestFingerprint)) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSE_MISMATCH',
          'Idempotency key was already used with a different edit request payload'
        );
      }

      res.status(200).json({
        ...(existingRecord.responseBody as Record<string, unknown>),
        idempotency: {
          key: idempotencyKey,
          replayed: true,
        },
      });
      return;
    }
  }

  try {
    // Fetch photo
    const photo = await dataAdapter.fetchData<Photo>('photos', photoId);
    if (!photo) {
      throw new AppError(404, 'PHOTO_NOT_FOUND', 'Photo not found');
    }

    if (photo.libraryId !== libraryId) {
      throw new AppError(404, 'PHOTO_NOT_FOUND', 'Photo not found in this library');
    }

    // TODO: Check user has edit permission

    assertEditVersionMatch(expectedCurrentVersion, photo.currentEditVersion);

    // Create new edit version
    const newVersion: EditVersion = {
      version: photo.currentEditVersion + 1,
      recipeVersion,
      createdAt: new Date().toISOString(),
      createdBy: userId,
      operations,
      description,
    };

    // Update photo document
    const updatedEditHistory = [...photo.editHistory, newVersion];
    
    await dataAdapter.updateData<Photo>('photos', photoId, {
      currentEditVersion: newVersion.version,
      editHistory: updatedEditHistory,
      thumbnailsOutdated: true,
      updatedAt: new Date().toISOString(),
    });

    logger.info(
      {
        photoId,
        libraryId,
        version: newVersion.version,
        operationCount: operations.length,
      },
      'Edits applied successfully'
    );

    emitMeteringEvent({
      tenantId: resolveTenantId({ libraryId }),
      type: 'edit.applied',
      count: 1,
      resourceId: photoId,
      meta: {
        libraryId,
        version: newVersion.version,
        operationCount: operations.length,
      },
    });

    const responseBody = {
      photoId,
      version: newVersion.version,
      status: 'processing',
      message: 'Edits applied, thumbnails are being regenerated',
      edit: {
        version: newVersion.version,
        recipeVersion: newVersion.recipeVersion,
        operations: newVersion.operations,
        description: newVersion.description,
        createdAt: newVersion.createdAt,
      },
    };

    if (idempotencyKey) {
      await storeEditIdempotencyRecord(dataAdapter, {
        key: idempotencyKey,
        userId,
        libraryId,
        photoId,
        request: requestFingerprint,
        responseBody,
        createdAt: new Date().toISOString(),
      });
    }

    // Return response
    res.status(202).json({
      ...responseBody,
      ...(idempotencyKey
        ? {
            idempotency: {
              key: idempotencyKey,
              replayed: false,
            },
          }
        : {}),
    });

    // Trigger thumbnail regeneration in background
    setImmediate(async () => {
      try {
        const { regenerateThumbnailsWithEdits } = await import(
          '../thumbnails/regenerate.js'
        );
        await regenerateThumbnailsWithEdits(
          photoId,
          libraryId,
          storageAdapter,
          dataAdapter
        );
      } catch (error) {
        logger.error(
          { err: error, photoId },
          'Failed to regenerate thumbnails after edit'
        );
      }
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error({ err: error, photoId }, 'Failed to apply edits');
    throw new AppError(
      500,
      'EDIT_FAILED',
      error instanceof Error ? error.message : 'Failed to apply edits'
    );
  }
}

/**
 * Revert to a previous edit version
 * POST /images/:libraryId/:photoId/revert
 */
export async function handleRevertVersion(
  req: Request,
  res: Response
): Promise<void> {
  const dataAdapter = req.app.locals.dataAdapter as DataAdapter;
  const storageAdapter = req.app.locals.storageAdapter as StorageAdapter;

  const libraryId = req.params.libraryId as string;
  const photoId = req.params.photoId as string;
  const userId = req.user?.uid || 'anonymous';
  const expectedCurrentVersion = parseExpectedCurrentVersion(
    req.header('If-Match-Edit-Version') ?? undefined
  );
  const { targetVersion } = req.body;

  if (typeof targetVersion !== 'number' || targetVersion < 0) {
    throw new AppError(400, 'INVALID_VERSION', 'Invalid target version');
  }

  let idempotencyKey: string | null;
  try {
    idempotencyKey = getNormalizedIdempotencyKey(req.header('Idempotency-Key'));
  } catch (error) {
    throw new AppError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      error instanceof Error ? error.message : 'Invalid idempotency key'
    );
  }

  const requestFingerprint = createRevertFingerprint(targetVersion);

  if (idempotencyKey) {
    const existingRecord = await getEditIdempotencyRecord(
      dataAdapter,
      userId,
      libraryId,
      photoId,
      idempotencyKey
    );

    if (existingRecord) {
      if (!editFingerprintMatches(existingRecord.request, requestFingerprint)) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSE_MISMATCH',
          'Idempotency key was already used with a different revert request payload'
        );
      }

      res.status(200).json({
        ...(existingRecord.responseBody as Record<string, unknown>),
        idempotency: {
          key: idempotencyKey,
          replayed: true,
        },
      });
      return;
    }
  }

  try {
    // Fetch photo
    const photo = await dataAdapter.fetchData<Photo>('photos', photoId);
    if (!photo) {
      throw new AppError(404, 'PHOTO_NOT_FOUND', 'Photo not found');
    }

    if (photo.libraryId !== libraryId) {
      throw new AppError(404, 'PHOTO_NOT_FOUND', 'Photo not found in this library');
    }

    assertEditVersionMatch(expectedCurrentVersion, photo.currentEditVersion);

    // Validate target version exists
    if (targetVersion > photo.editHistory.length) {
      throw new AppError(400, 'INVALID_VERSION', 'Target version does not exist');
    }

    // Version 0 is the original (no edits)
    if (targetVersion === photo.currentEditVersion) {
      const responseBody = {
        message: 'Already at target version',
        photoId,
        version: targetVersion,
      };

      if (idempotencyKey) {
        await storeEditIdempotencyRecord(dataAdapter, {
          key: idempotencyKey,
          userId,
          libraryId,
          photoId,
          request: requestFingerprint,
          responseBody,
          createdAt: new Date().toISOString(),
        });
      }

      res.json({
        ...responseBody,
        ...(idempotencyKey
          ? {
              idempotency: {
                key: idempotencyKey,
                replayed: false,
              },
            }
          : {}),
      });
      return;
    }

    // Update current version
    await dataAdapter.updateData<Photo>('photos', photoId, {
      currentEditVersion: targetVersion,
      thumbnailsOutdated: true,
      updatedAt: new Date().toISOString(),
    });

    logger.info(
      { photoId, libraryId, fromVersion: photo.currentEditVersion, toVersion: targetVersion },
      'Reverted to previous version'
    );

    const responseBody = {
      photoId,
      version: targetVersion,
      status: 'processing',
      message: 'Reverted to version, thumbnails are being regenerated',
    };

    if (idempotencyKey) {
      await storeEditIdempotencyRecord(dataAdapter, {
        key: idempotencyKey,
        userId,
        libraryId,
        photoId,
        request: requestFingerprint,
        responseBody,
        createdAt: new Date().toISOString(),
      });
    }

    res.status(202).json({
      ...responseBody,
      ...(idempotencyKey
        ? {
            idempotency: {
              key: idempotencyKey,
              replayed: false,
            },
          }
        : {}),
    });

    // Trigger thumbnail regeneration
    setImmediate(async () => {
      try {
        const { regenerateThumbnailsWithEdits } = await import(
          '../thumbnails/regenerate.js'
        );
        await regenerateThumbnailsWithEdits(
          photoId,
          libraryId,
          storageAdapter,
          dataAdapter
        );
      } catch (error) {
        logger.error(
          { err: error, photoId },
          'Failed to regenerate thumbnails after revert'
        );
      }
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error({ err: error, photoId }, 'Failed to revert version');
    throw new AppError(
      500,
      'REVERT_FAILED',
      error instanceof Error ? error.message : 'Failed to revert version'
    );
  }
}