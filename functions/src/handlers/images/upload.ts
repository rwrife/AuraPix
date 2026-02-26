import type { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import multer from 'multer';
import sharp from 'sharp';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import {
  generatePhotoPaths,
  getFileExtension,
} from '../../config/storage-paths.js';
import { createPhotoDocument } from '../../models/Photo.js';
import type { PhotoMetadata } from '../../models/Photo.js';

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max
  },
  fileFilter: (req, file, cb) => {
    // Accept images only
    if (!file.mimetype.startsWith('image/')) {
      cb(new AppError(400, 'Only image files are allowed'));
      return;
    }
    cb(null, true);
  },
});

export const uploadMiddleware = upload.single('file');

/**
 * Extract metadata from image using Sharp
 */
async function extractMetadata(
  imageBuffer: Buffer
): Promise<PhotoMetadata & { extension: string }> {
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const stats = await image.stats();

  // Try to extract EXIF data
  const exif = metadata.exif
    ? await image.metadata().then((m) => m.exif)
    : undefined;

  return {
    width: metadata.width || 0,
    height: metadata.height || 0,
    mimeType: `image/${metadata.format}`,
    sizeBytes: imageBuffer.length,
    takenAt: exif?.DateTimeOriginal
      ? new Date(exif.DateTimeOriginal).toISOString()
      : undefined,
    cameraMake: exif?.Make as string | undefined,
    cameraModel: exif?.Model as string | undefined,
    extension: metadata.format || 'jpg',
  };
}

/**
 * Handle photo upload
 * POST /images/:libraryId
 */
export async function handleUpload(
  req: Request,
  res: Response
): Promise<void> {
  const storageAdapter = req.app.locals.storageAdapter as StorageAdapter;
  const dataAdapter = req.app.locals.dataAdapter as DataAdapter;

  const { libraryId } = req.params;
  const file = req.file;

  if (!file) {
    throw new AppError(400, 'No file provided');
  }

  if (!libraryId) {
    throw new AppError(400, 'Library ID is required');
  }

  // TODO: Verify user has access to this library
  const userId = req.user?.uid || 'anonymous';

  try {
    // Generate unique photo ID
    const photoId = nanoid();

    // Extract metadata from image
    logger.info({ photoId, libraryId }, 'Extracting image metadata');
    const { extension, ...metadata } = await extractMetadata(file.buffer);

    // Generate storage paths
    const storagePaths = generatePhotoPaths(libraryId, photoId, extension);

    // Store original image
    logger.info({ photoId, path: storagePaths.original }, 'Storing original image');
    await storageAdapter.storeFile(storagePaths.original, file.buffer, {
      contentType: metadata.mimeType,
      customMetadata: {
        photoId,
        libraryId,
        originalName: file.originalname,
      },
    });

    // Create photo document
    const photo = createPhotoDocument(
      photoId,
      libraryId,
      file.originalname,
      storagePaths,
      metadata
    );

    // Update status to processing (thumbnails will be generated next)
    photo.status = 'processing';
    photo.thumbnailsOutdated = true;

    // Save to database
    logger.info({ photoId }, 'Saving photo document');
    await dataAdapter.storeData('photos', photoId, photo);

    // Return response immediately
    res.status(202).json({
      photoId,
      status: 'processing',
      message: 'Photo uploaded successfully, thumbnails are being generated',
      photo: {
        id: photo.id,
        libraryId: photo.libraryId,
        originalName: photo.originalName,
        status: photo.status,
        metadata: photo.metadata,
        createdAt: photo.createdAt,
      },
    });

    // Trigger thumbnail generation in background
    // For now, we'll do it inline, but in production this would be a queue/event
    setImmediate(async () => {
      try {
        const { generateThumbnailsForPhoto } = await import(
          '../thumbnails/generate.js'
        );
        await generateThumbnailsForPhoto(
          photoId,
          libraryId,
          storageAdapter,
          dataAdapter
        );
      } catch (error) {
        logger.error(
          { err: error, photoId },
          'Failed to generate thumbnails in background'
        );
      }
    });
  } catch (error) {
    logger.error({ err: error, libraryId }, 'Upload failed');
    throw new AppError(
      500,
      error instanceof Error ? error.message : 'Failed to upload photo'
    );
  }
}