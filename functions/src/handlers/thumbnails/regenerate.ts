import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { Photo } from '../../models/Photo.js';
import { generateAllThumbnails } from '../../services/image/processor.js';
import { applyEdits } from '../../services/edits/EditProcessor.js';
import { logger } from '../../utils/logger.js';

/**
 * Regenerate thumbnails with current edits applied
 */
export async function regenerateThumbnailsWithEdits(
  photoId: string,
  libraryId: string,
  storageAdapter: StorageAdapter,
  dataAdapter: DataAdapter
): Promise<void> {
  const logContext = { photoId, libraryId };
  logger.info(logContext, 'Starting thumbnail regeneration with edits');

  try {
    // Fetch photo document
    const photo = await dataAdapter.fetchData<Photo>('photos', photoId);
    if (!photo) {
      throw new Error(`Photo ${photoId} not found`);
    }

    // Check if storagePaths structure exists (needed for thumbnail generation)
    if (!photo.storagePaths) {
      logger.warn(logContext, 'Photo uses old storagePath format, cannot regenerate thumbnails');
      return;
    }

    // Load original image
    logger.info({ ...logContext, path: photo.storagePaths.original }, 'Loading original');
    const originalBuffer = await storageAdapter.readFile(
      photo.storagePaths.original
    );

    // Apply edits if any
    let processedBuffer = originalBuffer;
    if (photo.currentEditVersion > 0) {
      const currentEdit = photo.editHistory.find(
        (e) => e.version === photo.currentEditVersion
      );
      
      if (currentEdit) {
        logger.info(
          { ...logContext, version: currentEdit.version, ops: currentEdit.operations.length },
          'Applying edits before thumbnail generation'
        );
        processedBuffer = await applyEdits(originalBuffer, currentEdit.operations);
      }
    }

    // Generate thumbnails from processed image
    logger.info(logContext, 'Generating thumbnail variants');
    const thumbnails = await generateAllThumbnails(processedBuffer);

    // Store all derivatives (overwrites existing)
    logger.info(logContext, 'Storing derivative images');
    await Promise.all([
      storageAdapter.storeFile(
        photo.storagePaths.derivatives.small_webp,
        thumbnails.small_webp,
        { contentType: 'image/webp' }
      ),
      storageAdapter.storeFile(
        photo.storagePaths.derivatives.small_jpeg,
        thumbnails.small_jpeg,
        { contentType: 'image/jpeg' }
      ),
      storageAdapter.storeFile(
        photo.storagePaths.derivatives.medium_webp,
        thumbnails.medium_webp,
        { contentType: 'image/webp' }
      ),
      storageAdapter.storeFile(
        photo.storagePaths.derivatives.medium_jpeg,
        thumbnails.medium_jpeg,
        { contentType: 'image/jpeg' }
      ),
      storageAdapter.storeFile(
        photo.storagePaths.derivatives.large_webp,
        thumbnails.large_webp,
        { contentType: 'image/webp' }
      ),
      storageAdapter.storeFile(
        photo.storagePaths.derivatives.large_jpeg,
        thumbnails.large_jpeg,
        { contentType: 'image/jpeg' }
      ),
    ]);

    // Update photo document
    await dataAdapter.updateData<Photo>('photos', photoId, {
      status: 'ready',
      thumbnailsOutdated: false,
      updatedAt: new Date().toISOString(),
    });

    logger.info(logContext, 'Thumbnail regeneration with edits complete');
  } catch (error) {
    logger.error({ err: error, ...logContext }, 'Thumbnail regeneration failed');

    // Update photo status to error
    try {
      await dataAdapter.updateData<Photo>('photos', photoId, {
        status: 'error',
        updatedAt: new Date().toISOString(),
      });
    } catch (updateError) {
      logger.error({ err: updateError, photoId }, 'Failed to update photo status');
    }

    throw error;
  }
}