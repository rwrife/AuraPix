/**
 * Photo domain model with edit versioning
 */

import type { ExifData, NormalizedExif } from '../utils/exif.js';
import { DEFAULT_TENANT_ID, type TenantId } from '../domain/tenant/Tenant.js';

export type PhotoStatus = 'uploading' | 'processing' | 'ready' | 'error';

export interface PhotoMetadata {
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
  takenAt?: string;
  location?: { lat: number; lng: number };
  cameraMake?: string;
  cameraModel?: string;
  exif?: ExifData; // Complete EXIF data for information panel and search
}

export interface EditOperation {
  type: 'crop' | 'rotate' | 'adjust' | 'filter';
  params: Record<string, any>;
  order: number;
}

export interface EditVersion {
  version: number;
  recipeVersion: number;
  createdAt: string;
  createdBy: string;
  operations: EditOperation[];
  description?: string;
}

export interface StoragePaths {
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

export type PhotoSourceType = 'raster' | 'raw';

export interface Photo {
  id: string;
  libraryId: string;
  /**
   * Host-customer / billing tenant that owns this photo. Optional on the
   * type for backwards compatibility with documents written before the
   * tenant rollout — treat a missing value as {@link DEFAULT_TENANT_ID}.
   */
  tenantId?: TenantId;
  albumIds: string[];
  originalName: string;
  /**
   * Indicates what was originally uploaded.
   * - raster: jpeg/png/heic/etc
   * - raw: camera RAW (arw/cr3/nef/etc)
   */
  sourceType?: PhotoSourceType;
  /**
   * For RAW uploads, remember the original container/extension so we can
   * later enable RAW-aware editing pipelines.
   */
  rawOriginal?: {
    extension: string;
    mimeType: string;
  };
  // Support both old format (single string) and new format (object with derivatives)
  storagePath?: string; // Old format: single path to original (used when no thumbnails exist)
  storagePaths?: StoragePaths; // New format: paths object with original and derivatives
  metadata: PhotoMetadata;
  /**
   * Normalized EXIF summary (capture date, camera, lens, dimensions).
   * Best-effort: may be undefined when EXIF extraction failed or yielded no
   * usable fields. The full raw EXIF blob lives under {@link PhotoMetadata.exif}.
   */
  exif?: NormalizedExif;
  status: PhotoStatus;
  currentEditVersion: number;
  editHistory: EditVersion[];
  thumbnailsOutdated: boolean;
  createdAt: string;
  updatedAt: string;
}

export function createPhotoDocument(
  id: string,
  libraryId: string,
  originalName: string,
  storagePaths: StoragePaths,
  metadata: PhotoMetadata,
  source?: {
    sourceType: PhotoSourceType;
    rawOriginal?: { extension: string; mimeType: string };
  },
  tenantId: TenantId = DEFAULT_TENANT_ID,
  exif?: NormalizedExif
): Photo {
  const now = new Date().toISOString();

  return {
    id,
    libraryId,
    tenantId,
    albumIds: [],
    originalName,
    sourceType: source?.sourceType,
    rawOriginal: source?.rawOriginal,
    storagePaths,
    metadata,
    exif,
    status: 'uploading',
    currentEditVersion: 0,
    editHistory: [],
    thumbnailsOutdated: false,
    createdAt: now,
    updatedAt: now,
  };
}