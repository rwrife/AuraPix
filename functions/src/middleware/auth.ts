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
 * Mock authentication middleware for development
 * In production, this would verify Firebase Auth tokens
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (authConfig.mode === 'mock') {
    // Mock user for development
    req.user = {
      uid: 'mock-user-123',
      email: 'dev@aurapix.local',
    };
    next();
    return;
  }

  // TODO: Implement Firebase Auth token verification
  // const authHeader = req.headers.authorization;
  // if (!authHeader?.startsWith('Bearer ')) {
  //   res.status(401).json({ error: 'Unauthorized' });
  //   return;
  // }
  // const token = authHeader.substring(7);
  // Verify token with Firebase Admin SDK...

  res.status(501).json({ error: 'Firebase auth not yet implemented' });
}

/**
 * Optional authentication - sets user if token present, but doesn't require it
 */
export function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (authConfig.mode === 'mock') {
    req.user = {
      uid: 'mock-user-123',
      email: 'dev@aurapix.local',
    };
    next();
    return;
  }

  // TODO: Implement optional Firebase Auth
  next();
}

/**
 * Require authenticated user
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    logger.warn('Unauthenticated request to protected endpoint');
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}