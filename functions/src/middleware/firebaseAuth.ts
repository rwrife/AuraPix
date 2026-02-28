import admin from 'firebase-admin';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { AppError } from './errorHandler.js';

// Initialize Firebase Admin SDK
let firebaseInitialized = false;

export function initializeFirebaseAuth(): void {
  if (firebaseInitialized) {
    return;
  }

  try {
    // Initialize with default credentials (uses GOOGLE_APPLICATION_CREDENTIALS env var)
    // Check if admin.apps exists and has length, or if no apps are initialized
    if (!admin.apps || admin.apps.length === 0) {
      admin.initializeApp();
    }
    firebaseInitialized = true;
    logger.info('Firebase Admin SDK initialized');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize Firebase Admin SDK');
    throw error;
  }
}

export interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    email?: string;
    emailVerified?: boolean;
    displayName?: string;
    photoURL?: string;
  };
}

export async function firebaseAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Skip auth for health check and internal endpoints
    if (req.path === '/health' || req.path.startsWith('/internal/')) {
      next();
      return;
    }

    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid authorization header');
    }

    const token = authHeader.substring(7); // Remove "Bearer " prefix

    // Verify the Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(token);

    // Attach user info to request
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified,
      displayName: decodedToken.name,
      photoURL: decodedToken.picture,
    };

    logger.debug({ uid: req.user.uid, path: req.path }, 'User authenticated');
    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }

    logger.error({ error, path: req.path }, 'Firebase authentication failed');

    // Handle specific Firebase errors
    if ((error as any).code === 'auth/id-token-expired') {
      next(new AppError(401, 'TOKEN_EXPIRED', 'Authentication token has expired'));
      return;
    }

    if ((error as any).code === 'auth/id-token-revoked') {
      next(new AppError(401, 'TOKEN_REVOKED', 'Authentication token has been revoked'));
      return;
    }

    next(new AppError(401, 'UNAUTHORIZED', 'Authentication failed'));
  }
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    return;
  }
  next();
}