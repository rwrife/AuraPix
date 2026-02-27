/**
 * Image URL utilities for building API-based image URLs
 * 
 * Note: Authentication is handled by the Service Worker (image-auth-sw.js)
 * which intercepts requests and adds the auth token automatically.
 */

import { getApiUrl } from '../config/api';

export type ThumbnailSize = 'small' | 'medium' | 'large' | 'original';
export type ImageFormat = 'webp' | 'jpeg';

/**
 * Build an image URL for the backend API
 * The Service Worker will automatically add authentication token to requests
 */
export function buildImageUrl(
  libraryId: string,
  photoId: string,
  size: ThumbnailSize = 'medium',
  format: ImageFormat = 'webp'
): string {
  const params = new URLSearchParams({
    size,
    format,
  });
  
  return getApiUrl(`/images/${libraryId}/${photoId}?${params.toString()}`);
}

/**
 * Get thumbnail URL for grid display (medium by default)
 */
export function getThumbnailUrl(
  libraryId: string,
  photoId: string,
  format: ImageFormat = 'webp'
): string {
  return buildImageUrl(libraryId, photoId, 'medium', format);
}

/**
 * Get small blur placeholder URL
 */
export function getBlurPlaceholderUrl(
  libraryId: string,
  photoId: string,
  format: ImageFormat = 'jpeg'
): string {
  return buildImageUrl(libraryId, photoId, 'small', format);
}

/**
 * Get full-size original URL
 */
export function getOriginalUrl(
  libraryId: string,
  photoId: string,
  format: ImageFormat = 'jpeg'
): string {
  return buildImageUrl(libraryId, photoId, 'original', format);
}

/**
 * Get large thumbnail URL for filmstrip
 */
export function getLargeThumbnailUrl(
  libraryId: string,
  photoId: string,
  format: ImageFormat = 'webp'
): string {
  return buildImageUrl(libraryId, photoId, 'large', format);
}
