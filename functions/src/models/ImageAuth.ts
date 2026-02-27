import type { Photo } from './Photo.js';

/**
 * Signing key issued to clients for generating signed image URLs
 */
export interface SigningKey {
  key: string;           // Base64-encoded HMAC key
  expiresAt: string;     // ISO timestamp when this key expires
  userId?: string;       // User ID for authenticated requests
  shareToken?: string;   // Share token for public share requests
}

/**
 * Parsed and validated signature from image URL
 */
export interface ImageSignature {
  libraryId: string;
  photoId: string;
  size: 'original' | 'small' | 'medium' | 'large';
  format: 'jpeg' | 'webp';
  expiresAt: number;      // Unix timestamp (seconds)
  userId?: string;        // Present for authenticated requests
  shareToken?: string;    // Present for share link requests
}

/**
 * Result of authorization check for image access
 */
export interface ImageAuthResult {
  authorized: boolean;
  reason?: string;        // Reason for denial
  photo?: Photo;          // Photo document if authorized
}

/**
 * Library ownership/permission record
 */
export interface Library {
  id: string;
  userId: string;         // Owner user ID
  createdAt: string;
  updatedAt: string;
}

