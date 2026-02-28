/**
 * Image URL utilities for building HMAC-signed image URLs
 * 
 * Uses cryptographically signed URLs to authenticate image requests.
 * Each URL is signed client-side using a signing key from the backend
 * and validated server-side with short expiration times.
 */

import { getApiUrl } from '../config/api';
import { generateSignedImageUrl } from './signedUrls';
import type { ClientSigningKey } from '../domain/imageAuth/types';

export type ThumbnailSize = 'small' | 'medium' | 'large' | 'original';
export type ImageFormat = 'webp' | 'jpeg';

/**
 * Build a signed image URL for the backend API
 * Requires a valid signing key from ImageAuthProvider
 */
export async function buildImageUrl(
  libraryId: string,
  photoId: string,
  signingKey: ClientSigningKey,
  size: ThumbnailSize = 'medium',
  format: ImageFormat = 'webp'
): Promise<string> {
  return generateSignedImageUrl(
    {
      libraryId,
      photoId,
      size,
      format,
    },
    signingKey
  );
}

/**
 * Get thumbnail URL for grid display (medium by default)
 */
export async function getThumbnailUrl(
  libraryId: string,
  photoId: string,
  signingKey: ClientSigningKey,
  format: ImageFormat = 'webp'
): Promise<string> {
  return buildImageUrl(libraryId, photoId, signingKey, 'medium', format);
}

/**
 * Get small blur placeholder URL
 */
export async function getBlurPlaceholderUrl(
  libraryId: string,
  photoId: string,
  signingKey: ClientSigningKey,
  format: ImageFormat = 'jpeg'
): Promise<string> {
  return buildImageUrl(libraryId, photoId, signingKey, 'small', format);
}

/**
 * Get full-size original URL
 */
export async function getOriginalUrl(
  libraryId: string,
  photoId: string,
  signingKey: ClientSigningKey,
  format: ImageFormat = 'jpeg'
): Promise<string> {
  return buildImageUrl(libraryId, photoId, signingKey, 'original', format);
}

/**
 * Get large thumbnail URL for filmstrip
 */
export async function getLargeThumbnailUrl(
  libraryId: string,
  photoId: string,
  signingKey: ClientSigningKey,
  format: ImageFormat = 'webp'
): Promise<string> {
  return buildImageUrl(libraryId, photoId, signingKey, 'large', format);
}
