import type { Request, Response } from 'express';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { Photo, EditVersion } from '../../models/Photo.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { ApplyEditsSchema } from '../../utils/validation.js';
import { validateOperations } from '../../services/edits/EditProcessor.js';

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

  const { libraryId, photoId } = req.params;
  const userId = req.user?.uid || 'anonymous';

  // Validate request body
  const validation = ApplyEditsSchema.safeParse(req.body);
  if (!validation.success) {
    throw new AppError(400, `Invalid request: ${validation.error.message}`);
  }

  const { operations, description } = validation.data;

  // Validate operations
  const opsValidation = validateOperations(operations);
  if (!opsValidation.valid) {
    throw new AppError(400, `Invalid operations: ${opsValidation.errors.join(', ')}`);
  }

  try {
    // Fetch photo
    const photo = await dataAdapter.fetchData<Photo>('photos', photoId);
    if (!photo) {
      throw new AppError(404, 'Photo not found');
    }

    if (photo.libraryId !== libraryId) {
      throw new AppError(404, 'Photo not found in this library');
    }

    // TODO: Check user has edit permission

    // Create new edit version
    const newVersion: EditVersion = {
      version: photo.currentEditVersion + 1,
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

    // Return response
    res.status(202).json({
      photoId,
      version: newVersion.version,
      status: 'processing',
      message: 'Edits applied, thumbnails are being regenerated',
      edit: {
        version: newVersion.version,
        operations: newVersion.operations,
        description: newVersion.description,
        createdAt: newVersion.createdAt,
      },
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

  const { libraryId, photoId } = req.params;
  const { targetVersion } = req.body;

  if (typeof targetVersion !== 'number' || targetVersion < 0) {
    throw new AppError(400, 'Invalid target version');
  }

  try {
    // Fetch photo
    const photo = await dataAdapter.fetchData<Photo>('photos', photoId);
    if (!photo) {
      throw new AppError(404, 'Photo not found');
    }

    if (photo.libraryId !== libraryId) {
      throw new AppError(404, 'Photo not found in this library');
    }

    // Validate target version exists
    if (targetVersion > photo.editHistory.length) {
      throw new AppError(400, 'Target version does not exist');
    }

    // Version 0 is the original (no edits)
    if (targetVersion === photo.currentEditVersion) {
      res.json({
        message: 'Already at target version',
        photoId,
        version: targetVersion,
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

    res.status(202).json({
      photoId,
      version: targetVersion,
      status: 'processing',
      message: 'Reverted to version, thumbnails are being regenerated',
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
      error instanceof Error ? error.message : 'Failed to revert version'
    );
  }
}