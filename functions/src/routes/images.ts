import { Router } from 'express';
import { handleUpload, uploadMiddleware } from '../handlers/images/upload.js';
import { handleServeImage } from '../handlers/images/serve.js';
import { requireAuth } from '../middleware/auth.js';
import { createSlidingWindowRateLimiter } from '../middleware/rateLimit.js';
import { appCheckUploadMiddleware } from '../middleware/appCheck.js';
import { securityConfig } from '../config/index.js';

const router = Router();

const uploadRateLimiter = createSlidingWindowRateLimiter({
  windowMs: securityConfig.uploadRateLimit.windowMs,
  maxRequests: securityConfig.uploadRateLimit.maxRequests,
});

/**
 * Upload a photo
 * POST /images/:libraryId
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
 */
router.get('/:libraryId/:photoId', async (req, res, next) => {
  try {
    await handleServeImage(req, res);
  } catch (error) {
    next(error);
  }
});

export default router;
