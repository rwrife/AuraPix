import { Router } from 'express';
import { handleUpload, uploadMiddleware } from '../handlers/images/upload.js';
import { handleServeImage } from '../handlers/images/serve.js';
import { requireAuth } from '../middleware/auth.js';
import { createSlidingWindowRateLimiter } from '../middleware/rateLimit.js';
import { appCheckUploadMiddleware } from '../middleware/appCheck.js';
import { securityConfig } from '../config/index.js';
import { createSignedUrlMiddleware } from '../middleware/signedUrl.js';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { ShareViewTracker } from '../services/sharing/ShareViewTracker.js';

export interface ImageRoutesOptions {
  /**
   * Share-view tracker (issue #198). Optional; when wired, every
   * signed-URL image serve backed by a share token records a view row
   * and emits the `share.viewed` metering event with `bytesServed`.
   */
  shareViewTracker?: ShareViewTracker | null;
}

const router = Router();

/**
 * Factory function to create image routes with injected dependencies
 * @param dataAdapter - Data adapter for database operations
 */
export function createImageRoutes(
  dataAdapter: DataAdapter,
  options: ImageRoutesOptions = {}
) {
  const router = Router();

  const uploadRateLimiter = createSlidingWindowRateLimiter({
    windowMs: securityConfig.uploadRateLimit.windowMs,
    maxRequests: securityConfig.uploadRateLimit.maxRequests,
  });

  // Create signed URL middleware with injected data adapter. Passing the
  // share-view tracker (issue #198) here is what wires up share-link
  // analytics + `share.viewed` bytes accounting on every image serve.
  const signedUrlMiddleware = createSignedUrlMiddleware(dataAdapter, {
    shareViewTracker: options.shareViewTracker ?? null,
  });

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
