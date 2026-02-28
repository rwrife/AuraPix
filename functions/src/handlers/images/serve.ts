import type { Request, Response } from 'express';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { getImageCache } from '../../services/caching/ImageCache.js';
import { ServeImageQuerySchema } from '../../utils/validation.js';
import { applyEdits } from '../../services/edits/EditProcessor.js';

/**
 * Normalize a storage path by removing gs://bucket-name/ prefix if present
 * @param path - Storage path (may include gs:// prefix)
 * @returns Path without gs:// prefix
 */
function normalizeStoragePath(path: string): string {
  // Remove gs://bucket-name/ prefix if present
  const gsPrefix = /^gs:\/\/[^/]+\//;
  return path.replace(gsPrefix, '');
}

/**
 * Serve an image with caching
 * GET /images/:libraryId/:photoId?size=medium&format=webp
 */
export async function handleServeImage(
  req: Request,
  res: Response
): Promise<void> {
  const storageAdapter = req.app.locals.storageAdapter as StorageAdapter;
  const imageCache = getImageCache();

  const libraryId = req.params.libraryId as string;
  const photoId = req.params.photoId as string;

  // Validate query parameters
  const queryResult = ServeImageQuerySchema.safeParse(req.query);
  if (!queryResult.success) {
    throw new AppError(400, 'INVALID_QUERY', 'Invalid query parameters');
  }

  const { size, format } = queryResult.data;

  // Photo and authorization already verified by signedUrlMiddleware
  const photo = req.imageAuth?.photo;
  if (!photo) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Image authorization not set by middleware');
  }

  try {
    // Verify photo belongs to requested library (extra safety check)
    if (photo.libraryId !== libraryId) {
      throw new AppError(404, 'PHOTO_NOT_FOUND', 'Photo not found in this library');
    }

    logger.debug(
      {
        photoId,
        libraryId,
        size,
        format,
        authorized: req.imageAuth?.authorized,
      },
      'Serving authorized image'
    );

    // Check if thumbnails are outdated
    if (photo.thumbnailsOutdated && size !== 'original') {
      res.status(202).json({
        message: 'Thumbnails are being regenerated',
        photoId,
        status: photo.status,
        retryAfter: 5, // Retry after 5 seconds
      });
      return;
    }

    // Determine storage path
    // Handle both old format (single storagePath string) and new format (storagePaths object)
    let storagePath: string;
    let servingOriginalForThumbnail = false;
    
    if (photo.storagePath && typeof photo.storagePath === 'string') {
      // Old format: single storagePath string pointing to original
      // Thumbnails don't exist yet, so serve original for all sizes
      storagePath = normalizeStoragePath(photo.storagePath);
      if (size !== 'original') {
        servingOriginalForThumbnail = true;
        logger.info({ 
          photoId, 
          requestedSize: size, 
          requestedFormat: format 
        }, 'Thumbnails not available, serving original image instead');
      }
    } else if (photo.storagePaths && typeof photo.storagePaths === 'object') {
      // New format: storagePaths object with original and derivatives
      if (size === 'original') {
        storagePath = normalizeStoragePath(photo.storagePaths.original);
      } else {
        // Get derivative path
        const derivativeKey =
          `${size}_${format}` as keyof typeof photo.storagePaths.derivatives;
        storagePath = normalizeStoragePath(photo.storagePaths.derivatives[derivativeKey]);
      }
    } else {
      throw new AppError(500, 'INVALID_PHOTO', 'Photo document has invalid storage path structure');
    }

    // Try cache first (for derivatives only)
    let imageBuffer: Buffer;
    if (size !== 'original') {
      const cached = await imageCache.get(
        photoId,
        size,
        format,
        photo.currentEditVersion
      );
      
      if (cached) {
        logger.debug({ photoId, size, format }, 'Serving from cache');
        imageBuffer = cached;
      } else {
        // Load from storage
        logger.debug({ photoId, size, format, storagePath }, 'Loading from storage');
        imageBuffer = await storageAdapter.readFile(storagePath);
        
        // Cache for future requests
        await imageCache.set(
          photoId,
          size,
          format,
          photo.currentEditVersion,
          imageBuffer
        );
      }
    } else {
      // Original images: check cache first if edits applied
      if (photo.currentEditVersion > 0) {
        const cached = await imageCache.get(
          photoId,
          'original',
          format,
          photo.currentEditVersion
        );

        if (cached) {
          logger.debug({ photoId, version: photo.currentEditVersion }, 'Serving edited original from cache');
          imageBuffer = cached;
        } else {
          // Load original and apply edits
          logger.debug({ photoId, storagePath, version: photo.currentEditVersion }, 'Loading and editing original');
          const originalBuffer = await storageAdapter.readFile(storagePath);
          
          const currentEdit = photo.editHistory.find(
            (e) => e.version === photo.currentEditVersion
          );
          
          if (currentEdit) {
            imageBuffer = await applyEdits(originalBuffer, currentEdit.operations);
          } else {
            imageBuffer = originalBuffer;
          }

          // Cache the edited version
          await imageCache.set(
            photoId,
            'original',
            format,
            photo.currentEditVersion,
            imageBuffer
          );
        }
      } else {
        // No edits: load original directly (no caching for large files)
        logger.debug({ photoId, storagePath }, 'Loading original');
        imageBuffer = await storageAdapter.readFile(storagePath);
      }
    }

    // Set cache headers
    const maxAge = 7 * 24 * 60 * 60; // 7 days
    res.set({
      'Content-Type': format === 'webp' ? 'image/webp' : 'image/jpeg',
      'Content-Length': imageBuffer.length,
      'Cache-Control': `public, max-age=${maxAge}, immutable`,
      'ETag': `"${photoId}-${photo.currentEditVersion}"`,
      'Last-Modified': new Date(photo.updatedAt).toUTCString(),
    });

    // Check if client has cached version
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === `"${photoId}-${photo.currentEditVersion}"`) {
      res.status(304).end();
      return;
    }

    // Send image
    res.status(200).send(imageBuffer);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    
    logger.error(
      { err: error, photoId, libraryId },
      'Failed to serve image'
    );
    throw new AppError(
      500,
      'SERVE_FAILED',
      error instanceof Error ? error.message : 'Failed to serve image'
    );
  }
}