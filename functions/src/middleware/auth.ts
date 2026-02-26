import type { Request, Response, NextFunction } from 'express';
import { authConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

export interface AuthUser {
  uid: string;
  email?: string;
}

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Authentication middleware for local and Firebase modes
 * 
 * In local mode (single-user):
 * - All requests are treated as authenticated with a local user
 * - No token verification required
 * 
 * In Firebase mode (multi-user):
 * - Requires Bearer token in Authorization header
 * - Verifies token with Firebase Admin SDK
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (authConfig.mode === 'mock') {
    // Local/mock mode: auto-authenticate as local user
    // This matches the frontend's single-user local mode
    req.user = {
      uid: 'local-user-1',
      email: 'local@aurapix.local',
    };
    next();
    return;
  }

  // Firebase mode: verify Bearer token
  // TODO: Implement Firebase Auth token verification
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized - Bearer token required' });
    return;
  }
  
  // const token = authHeader.substring(7);
  // Verify token with Firebase Admin SDK...
  res.status(501).json({ error: 'Firebase auth not yet implemented' });
}

/**
 * Optional authentication - sets user if token present, but doesn't require it
 * 
 * In local mode: always sets the local user
 * In Firebase mode: attempts to verify token if present, but continues anyway
 */
export function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (authConfig.mode === 'mock') {
    // Local mode: always authenticated
    req.user = {
      uid: 'local-user-1',
      email: 'local@aurapix.local',
    };
    next();
    return;
  }

  // Firebase mode: optional auth
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    // TODO: Attempt to verify token, but don't fail if invalid
    // For now, just continue without user
  }
  
  next();
}

/**
 * Require authenticated user
 * 
 * In local mode: always passes (user is always set)
 * In Firebase mode: ensures user was authenticated by previous middleware
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    logger.warn('Unauthenticated request to protected endpoint', {
      path: req.path,
      method: req.method,
    });
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}
