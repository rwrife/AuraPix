/**
 * Utilities for generating deterministic Cloud Storage paths.
 * Ensures consistent organization of media files across the storage bucket.
 */

export interface StoragePathOptions {
  libraryId: string;
  photoId: string;
  fileName: string;
  isOriginal?: boolean;
  isThumbnail?: boolean;
}

/**
 * Generate a storage path for a photo file.
 * Format: libraries/{libraryId}/photos/{photoId}/original/{fileName}
 * or: libraries/{libraryId}/photos/{photoId}/thumbnail/{fileName}
 */
export function generatePhotoStoragePath(options: StoragePathOptions): string {
  const { libraryId, photoId, fileName, isOriginal = true } = options;
  const folder = isOriginal ? 'original' : 'thumbnail';
  return `libraries/${libraryId}/photos/${photoId}/${folder}/${fileName}`;
}

/**
 * Generate a thumbnail path from an original photo path.
 */
export function getThumbnailPath(originalPath: string): string {
  return originalPath.replace('/original/', '/thumbnail/');
}

/**
 * Extract library ID from a storage path.
 */
export function extractLibraryId(storagePath: string): string | null {
  const match = storagePath.match(/^libraries\/([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Extract photo ID from a storage path.
 */
export function extractPhotoId(storagePath: string): string | null {
  const match = storagePath.match(/\/photos\/([^/]+)\//);
  return match ? match[1] : null;
}