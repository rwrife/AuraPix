import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errorHandler.js';
import { securityConfig } from '../config/index.js';

const APP_CHECK_HEADER = 'x-firebase-appcheck';

function getBypassTokens(): Set<string> {
  const raw = securityConfig.appCheck.bypassTokens;
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
  );
}

/**
 * Baseline App Check gate for upload endpoints.
 *
 * This intentionally starts as a conservative compatibility baseline:
 * - Disabled by default (APP_CHECK_ENFORCE_UPLOADS=false)
 * - Requires presence of X-Firebase-AppCheck when enabled
 * - Supports explicit bypass tokens for local/testing rollout
 *
 * TODO: Replace structural validation with Firebase Admin appCheck().verifyToken()
 * when deployment credentials and rollout policy are finalized.
 */
export function appCheckUploadMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!securityConfig.appCheck.enforceUploads) {
    next();
    return;
  }

  const token = req.header(APP_CHECK_HEADER);
  if (!token) {
    throw new AppError(
      401,
      'APP_CHECK_REQUIRED',
      'App Check token required for upload operations'
    );
  }

  const bypassTokens = getBypassTokens();
  if (bypassTokens.has(token)) {
    next();
    return;
  }

  // Minimal structural check for baseline rollout.
  if (token.trim().length < 20) {
    throw new AppError(403, 'APP_CHECK_INVALID', 'Invalid App Check token');
  }

  next();
}
