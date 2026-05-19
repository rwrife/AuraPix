/**
 * Centralized path generation for consistent storage organization
 */

import { DEFAULT_TENANT_ID, type TenantId } from '../domain/tenant/Tenant.js';

/**
 * Feature flag: when enabled, original/derivative storage paths are
 * partitioned by tenant id (`originals/{tenantId}/{libraryId}/{photoId}/...`).
 * Defaults to off so existing deployments keep using the legacy layout.
 */
export const TENANT_AWARE_STORAGE_PATHS =
  process.env.TENANT_AWARE_STORAGE_PATHS === 'true';

function buildBaseDir(
  libraryId: string,
  photoId: string,
  tenantId: TenantId | undefined
): string {
  if (TENANT_AWARE_STORAGE_PATHS) {
    return `${tenantId ?? DEFAULT_TENANT_ID}/${libraryId}/${photoId}`;
  }
  return `${libraryId}/${photoId}`;
}

export interface PhotoPaths {
  original: string;
  derivatives: {
    small_webp: string;
    small_jpeg: string;
    medium_webp: string;
    medium_jpeg: string;
    large_webp: string;
    large_jpeg: string;
    preview_jpeg: string;
  };
}

export function generatePhotoPaths(
  libraryId: string,
  photoId: string,
  originalExtension: string,
  tenantId?: TenantId
): PhotoPaths {
  const baseDir = buildBaseDir(libraryId, photoId, tenantId);
  
  return {
    original: `originals/${baseDir}/original.${originalExtension}`,
    derivatives: {
      small_webp: `derivatives/${baseDir}/thumb_small.webp`,
      small_jpeg: `derivatives/${baseDir}/thumb_small.jpg`,
      medium_webp: `derivatives/${baseDir}/thumb_medium.webp`,
      medium_jpeg: `derivatives/${baseDir}/thumb_medium.jpg`,
      large_webp: `derivatives/${baseDir}/thumb_large.webp`,
      large_jpeg: `derivatives/${baseDir}/thumb_large.jpg`,
      preview_jpeg: `derivatives/${baseDir}/preview.jpg`,
    },
  };
}

export function getCachePath(
  libraryId: string,
  photoId: string,
  version: number,
  format: 'webp' | 'jpeg'
): string {
  return `${libraryId}/${photoId}/original-v${version}.${format}`;
}

export function getFileExtension(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext || 'jpg';
}

export function getThumbnailPath(
  libraryId: string,
  photoId: string,
  size: 'small' | 'medium' | 'large',
  format: 'webp' | 'jpeg'
): string {
  return `derivatives/${libraryId}/${photoId}/thumb_${size}.${format}`;
}