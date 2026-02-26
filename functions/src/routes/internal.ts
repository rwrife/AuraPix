import { Router } from 'express';
import type { Request, Response } from 'express';
import type { StorageAdapter } from '../adapters/storage/StorageAdapter.js';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { generateThumbnailsForPhoto } from '../handlers/thumbnails/generate.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Manually trigger thumbnail generation
 * POST /internal/generate-thumbnails/:libraryId/:photoId
 */
/**
 * Health check endpoint
 * GET /internal/health
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'aurapix-backend',
    version: '1.0.0',
  });
});

/**
 * Manually trigger thumbnail generation
 * POST /internal/generate-thumbnails/:libraryId/:photoId
 */
router.post(
  '/generate-thumbnails/:libraryId/:photoId',
  async (req: Request, res: Response, next) => {
    try {
      const { libraryId, photoId } = req.params;
      const storageAdapter = req.app.locals.storageAdapter as StorageAdapter;
      const dataAdapter = req.app.locals.dataAdapter as DataAdapter;

      logger.info({ libraryId, photoId }, 'Manual thumbnail generation requested');

      await generateThumbnailsForPhoto(
        photoId,
        libraryId,
        storageAdapter,
        dataAdapter
      );

      res.json({
        message: 'Thumbnails generated successfully',
        photoId,
        libraryId,
      });
    } catch (error) {
      logger.error({ err: error }, 'Thumbnail generation failed');
      next(
        new AppError(
          500,
          error instanceof Error ? error.message : 'Thumbnail generation failed'
        )
      );
    }
  }
);

export default router;