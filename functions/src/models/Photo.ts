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

/** Lightroom-style 0–5 star triage rating. 0 means unrated. */
export type PhotoRating = 0 | 1 | 2 | 3 | 4 | 5;

/** Lightroom-style pick/reject flag. `null` (default) means unflagged. */
export type PhotoFlag = 'pick' | 'reject' | null;

/**
 * Lightroom-style color label (third triage axis, complementing rating + flag).
 * `null` (default) means no color label is assigned. Issue #184.
 */
export type PhotoColorLabel = 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null;

export const PHOTO_RATING_VALUES: readonly PhotoRating[] = [0, 1, 2, 3, 4, 5];
export const PHOTO_FLAG_VALUES: readonly Exclude<PhotoFlag, null>[] = ['pick', 'reject'];
export const PHOTO_COLOR_LABEL_VALUES: readonly Exclude<PhotoColorLabel, null>[] = [
  'red',
  'yellow',
  'green',
  'blue',
  'purple',
];

export function isPhotoRating(value: unknown): value is PhotoRating {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (PHOTO_RATING_VALUES as readonly number[]).includes(value)
  );
}

export function isPhotoFlag(value: unknown): value is PhotoFlag {
  if (value === null) return true;
  return typeof value === 'string' && (PHOTO_FLAG_VALUES as readonly string[]).includes(value);
}

export function isPhotoColorLabel(value: unknown): value is PhotoColorLabel {
  if (value === null) return true;
  return (
    typeof value === 'string' &&
    (PHOTO_COLOR_LABEL_VALUES as readonly string[]).includes(value)
  );
}

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
  /**
   * Soft-delete (Trash) timestamp. When non-null, the photo is in the
   * tenant's trash and is hidden from default list queries until either
   * restored or hard-deleted by the purge job. See issue #152.
   */
  trashedAt?: string | null;
  /**
   * User id (or tenant subject) that initiated the soft-delete.
   */
  trashedBy?: string | null;
  /**
   * Freeform keyword tags (Lightroom-style). Normalized lowercase, trimmed,
   * each entry 1–64 chars. Capped at 50 unique tags per photo. Optional
   * for backwards compatibility with photos written before issue #173;
   * treat a missing value as an empty array.
   */
  tags?: string[];
  /**
   * Lightroom-style triage rating, 0–5 stars. Optional for backwards
   * compatibility with photos written before triage rollout; treat a
   * missing value as 0 (unrated). See issue #141.
   */
  rating?: PhotoRating;
  /**
   * Lightroom-style pick/reject flag. Optional for backwards compatibility;
   * treat a missing value as `null` (unflagged). See issue #149.
   */
  flag?: PhotoFlag;
  /**
   * Lightroom-style color label (third triage axis). Optional for backwards
   * compatibility; treat a missing value as `null` (no label). See issue #184.
   */
  colorLabel?: PhotoColorLabel;
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
    trashedAt: null,
    trashedBy: null,
    tags: [],
    rating: 0,
    flag: null,
    colorLabel: null,
  };
}