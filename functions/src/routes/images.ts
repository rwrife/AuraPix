import { Router } from 'express';
import { handleUpload, uploadMiddleware } from '../handlers/images/upload.js';
import { handleServeImage } from '../handlers/images/serve.js';
import { requireAuth } from '../middleware/auth.js';
import { createSlidingWindowRateLimiter } from '../middleware/rateLimit.js';
import { appCheckUploadMiddleware } from '../middleware/appCheck.js';
import { securityConfig } from '../config/index.js';
import { createSignedUrlMiddleware } from '../middleware/signedUrl.js';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';

const router = Router();

/**
 * Factory function to create image routes with injected dependencies
 * @param dataAdapter - Data adapter for database operations
 */
export function createImageRoutes(dataAdapter: DataAdapter) {
  const router = Router();

  const uploadRateLimiter = createSlidingWindowRateLimiter({
    windowMs: securityConfig.uploadRateLimit.windowMs,
    maxRequests: securityConfig.uploadRateLimit.maxRequests,
  });

  // Create signed URL middleware with injected data adapter
  const signedUrlMiddleware = createSignedUrlMiddleware(dataAdapter);

  /**
   * Upload a photo
   * POST /images/:libraryId
   * Requires Firebase authentication
   */
  router.post('/:libraryId', requireAuth, appCheckUploadMiddleware, uploadRateLimiter, uploadMiddleware, async (req, res, next) => {
    try {
      await handleUpload(req, res);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Serve a photo
   * GET /images/:libraryId/:photoId
   * Requires signed URL with valid signature
   */
  router.get('/:libraryId/:photoId', signedUrlMiddleware, async (req, res, next) => {
    try {
      await handleServeImage(req, res);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default router;
