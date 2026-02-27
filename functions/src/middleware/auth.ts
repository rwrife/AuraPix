import type { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';
import { authConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { initializeFirebaseAuth } from './firebaseAuth.js';

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
 * - Accepts Bearer token in Authorization header OR token query parameter
 * - Verifies token with Firebase Admin SDK
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
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

  // Firebase mode: verify Bearer token from Authorization header only
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized - Bearer token required in Authorization header' });
    return;
  }
  
  const token = authHeader.substring(7);
  
  // Initialize Firebase Admin if not already done
  initializeFirebaseAuth();
  
  // Verify token with Firebase Admin SDK
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // Set authenticated user from token
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
    };
    
    logger.debug({ uid: req.user.uid, path: req.path }, 'User authenticated via Firebase Admin SDK');
    next();
  } catch (error) {
    // Handle Firebase token verification errors
    logger.error({ error, path: req.path }, 'Firebase token verification failed');
    
    if ((error as any).code === 'auth/id-token-expired') {
      res.status(401).json({ error: 'Authentication token has expired' });
      return;
    }
    
    if ((error as any).code === 'auth/id-token-revoked') {
      res.status(401).json({ error: 'Authentication token has been revoked' });
      return;
    }
    
    if ((error as any).code === 'auth/argument-error') {
      res.status(401).json({ error: 'Invalid authentication token format' });
      return;
    }
    
    res.status(401).json({ error: 'Authentication failed' });
    return;
  }
}

/**
 * Optional authentication - sets user if token present, but doesn't require it
 * 
 * In local mode: always sets the local user
 * In Firebase mode: attempts to verify token if present, but continues anyway
 */
export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
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
    const token = authHeader.substring(7);
    
    // Initialize Firebase Admin if not already done
    initializeFirebaseAuth();
    
    // Attempt to verify token, but don't fail if invalid
    try {
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.user = {
        uid: decodedToken.uid,
        email: decodedToken.email,
      };
      logger.debug({ uid: req.user.uid, path: req.path }, 'User optionally authenticated');
    } catch (error) {
      // Token invalid, but that's okay for optional auth
      logger.debug({ error, path: req.path }, 'Optional auth token verification failed - continuing without user');
    }
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
    logger.warn({
      path: req.path,
      method: req.method,
    }, 'Unauthenticated request to protected endpoint');
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}
