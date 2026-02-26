import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { Photo } from '../../models/Photo.js';
import { generateAllThumbnails } from '../../services/image/processor.js';
import { logger } from '../../utils/logger.js';

/**
 * Generate thumbnails for a photo
 * Called after photo upload or when regenerating thumbnails
 */
export async function generateThumbnailsForPhoto(
  photoId: string,
  libraryId: string,
  storageAdapter: StorageAdapter,
  dataAdapter: DataAdapter
): Promise<void> {
  const logContext = { photoId, libraryId };
  logger.info(logContext, 'Starting thumbnail generation');

  try {
    // Fetch photo document
    const photo = await dataAdapter.fetchData<Photo>('photos', photoId);
    if (!photo) {
      throw new Error(`Photo ${photoId} not found`);
    }

    // Check if already processing (idempotency)
    if (
      photo.status === 'ready' &&
      !photo.thumbnailsOutdated &&
      photo.storagePaths.derivatives
    ) {
      // Verify derivatives exist
      const firstDerivative = photo.storagePaths.derivatives.small_webp;
      const exists = await storageAdapter.fileExists(firstDerivative);
      if (exists) {
        logger.info(logContext, 'Thumbnails already exist, skipping');
        return;
      }
    }

    // Load original image
    logger.info({ ...logContext, path: photo.storagePaths.original }, 'Loading original');
    const originalBuffer = await storageAdapter.readFile(
      photo.storagePaths.original
    );

    // Generate all thumbnail variants
    logger.info(logContext, 'Generating thumbnail variants');
    const thumbnails = await generateAllThumbnails(originalBuffer);

    // Store all derivatives
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

    logger.info(logContext, 'Thumbnail generation complete');
  } catch (error) {
    logger.error({ err: error, ...logContext }, 'Thumbnail generation failed');

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