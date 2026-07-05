import type { Request, Response, NextFunction } from 'express';
import { SignatureValidator } from '../services/imageAuth/SignatureValidator.js';
import { ImageAuthorizer } from '../services/imageAuth/ImageAuthorizer.js';
import { signingConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { AppError } from './errorHandler.js';
import type { ImageAuthResult } from '../models/ImageAuth.js';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { ShareViewTracker } from '../services/sharing/ShareViewTracker.js';

export interface SignedUrlMiddlewareOptions {
  /**
   * Share-view tracker (issue #198). When wired, every successful
   * share-token access records a view (with de-dup, IP/UA hashing, and
   * bytesServed accounting) and emits `share.viewed` via the tracker.
   * Optional so existing call sites without analytics continue to work.
   */
  shareViewTracker?: ShareViewTracker | null;
}

// Extend Express Request type to include imageAuth
declare global {
  namespace Express {
    interface Request {
      imageAuth?: ImageAuthResult;
    }
  }
}

/**
 * Middleware to validate signed image URLs and authorize access
 * Replaces requireAuth middleware for image serving endpoints
 */
export function createSignedUrlMiddleware(
  dataAdapter: DataAdapter,
  options: SignedUrlMiddlewareOptions = {}
) {
  const signatureValidator = new SignatureValidator(signingConfig.masterSecret);
  const imageAuthorizer = new ImageAuthorizer(dataAdapter);
  if (options.shareViewTracker) {
    imageAuthorizer.setViewTracker(options.shareViewTracker);
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Extract signature from query parameters
      const signatureParam = req.query.sig as string;

      if (!signatureParam) {
        throw new AppError(401, 'MISSING_SIGNATURE', 'Image signature is required');
      }

      logger.debug({ url: req.url }, 'Validating signed image URL');

      // Parse and validate signature structure
      const signature = signatureValidator.parseSignature(signatureParam);
      if (!signature) {
        throw new AppError(401, 'INVALID_SIGNATURE', 'Image signature is malformed or expired');
      }

      // Validate HMAC signature
      const isValid = signatureValidator.validateSignature(signature, req.query);
      if (!isValid) {
        throw new AppError(401, 'INVALID_SIGNATURE', 'Image signature verification failed');
      }

      logger.debug(
        {
          libraryId: signature.libraryId,
          photoId: signature.photoId,
          userId: signature.userId,
          shareToken: signature.shareToken ? signature.shareToken.substring(0, 8) : undefined,
        },
        'Signature validated, checking authorization'
      );

      // Fetch photo document from database
      const photo = await dataAdapter.getPhoto(signature.libraryId, signature.photoId);
      
      if (!photo) {
        throw new AppError(404, 'PHOTO_NOT_FOUND', 'Photo not found');
      }

      // Check if signature grants access to this photo. Pass request
      // context so the share-view tracker (issue #198) can hash the
      // client IP / UA and attach referrerHost to the metering event.
      // The context is ignored for non-share (user-ID) grants and never
      // affects the authorization decision.
      const forwardedFor = String(
        (req.headers['x-forwarded-for'] as string | undefined) ?? ''
      );
      const clientIp =
        (forwardedFor.split(',')[0] ?? '').trim() ||
        req.socket?.remoteAddress ||
        req.ip ||
        null;
      const userAgent = req.get('user-agent') ?? null;
      const referrer = req.get('referer') ?? req.get('referrer') ?? null;
      const authResult = await imageAuthorizer.authorizeImageAccess(
        signature,
        photo,
        {
          ip: clientIp,
          userAgent,
          referrer,
          // photo.metadata.sizeBytes is the underlying media size and is
          // the best available approximation of the bytes we're about
          // to serve. Derivatives are handled by callers that know the
          // variant size and can attach it before authorization.
          bytesServed: photo?.metadata?.sizeBytes ?? null,
        }
      );

      if (!authResult.authorized) {
        logger.warn(
          {
            libraryId: signature.libraryId,
            photoId: signature.photoId,
            reason: authResult.reason,
          },
          'Image access denied'
        );
        throw new AppError(
          403,
          'ACCESS_DENIED',
          authResult.reason || 'You do not have permission to access this image'
        );
      }

      // Attach authorization result to request for handler to use
      req.imageAuth = authResult;

      logger.debug(
        {
          libraryId: signature.libraryId,
          photoId: signature.photoId,
          authorized: true,
        },
        'Image access authorized'
      );

      next();
    } catch (error) {
      // Let error handler middleware deal with it
      next(error);
    }
  };
}

/**
 * Export a factory function that requires DataAdapter injection
 * Usage in routes: const signedUrlMiddleware = createSignedUrlMiddleware(dataAdapter);
 */
export { createSignedUrlMiddleware as signedUrlMiddleware };