import { Router } from 'express';
import type { Request, Response } from 'express';
import { SigningKeyService } from '../services/imageAuth/SigningKeyService.js';
import { authMiddleware, requireAuth } from '../middleware/auth.js';
import { signingConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { recordAuditEvent } from '../services/audit/AuditService.js';

// Initialize signing key service
const signingKeyService = new SigningKeyService(
  signingConfig.masterSecret,
  signingConfig.keyExpirationSeconds
);

export function createSigningRouter(dataAdapter: DataAdapter): Router {
  const router = Router();

  /**
   * Get signing key for authenticated user
   * POST /api/signing/key
   */
  router.post('/key', authMiddleware, requireAuth, async (req: Request, res: Response, next) => {
    try {
      const userId = req.user?.uid;
      if (!userId) {
        throw new AppError(401, 'UNAUTHORIZED', 'User ID not found in request');
      }

      logger.debug({ userId }, 'Generating signing key for user');

      const signingKey = await signingKeyService.generateSigningKey(userId);

      await recordAuditEvent(dataAdapter, {
        eventType: 'auth.signing_key.requested',
        actorId: userId,
        targetId: userId,
        metadata: {
          keyFingerprint: signingKey.key.slice(0, 12),
          expiresAt: signingKey.expiresAt,
        },
      });

      res.status(200).json(signingKey);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Get signing key for share token
   * POST /api/signing/key/share/:token
   */
  router.post('/key/share/:token', async (req: Request, res: Response, next) => {
    try {
      const token = req.params.token as string;
      const actorId = req.user?.uid;

      if (!token || typeof token !== 'string') {
        throw new AppError(400, 'INVALID_REQUEST', 'Share token is required');
      }

      logger.debug({ token: token.substring(0, 8), actorId }, 'Generating signing key for share token');

      // TODO: Validate share token exists and is not revoked/expired
      // For now, generate key for any token
      const signingKey = await signingKeyService.generateSigningKey(undefined, token);

      if (actorId) {
        await recordAuditEvent(dataAdapter, {
          eventType: 'sharing.signing_key.requested',
          actorId,
          targetId: token.substring(0, 12),
          metadata: {
            keyId: signingKey.keyId,
            expiresAt: signingKey.expiresAt,
          },
        });
      }

      res.status(200).json(signingKey);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
