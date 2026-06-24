export type PhotoStatus = 'pending' | 'ready' | 'error';

/** Lightroom-style triage rating from 0 (unset) to 5 stars. */
export type PhotoRating = 0 | 1 | 2 | 3 | 4 | 5;

/** Lightroom-style pick/reject flag; `null` (default) means unflagged. */
export type PhotoFlag = 'pick' | 'reject' | null;

/**
 * Lightroom-style color label (third triage axis, complementing rating + flag).
 * `null` (default) means no color label is assigned. Issue #184.
 */
export type PhotoColorLabel = 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null;

/** Allowed values for {@link PhotoRating}. Useful for validation. */
export const PHOTO_RATING_VALUES: readonly PhotoRating[] = [0, 1, 2, 3, 4, 5];

/** Allowed non-null values for {@link PhotoFlag}. Useful for validation. */
export const PHOTO_FLAG_VALUES: readonly Exclude<PhotoFlag, null>[] = ['pick', 'reject'];

/** Allowed non-null values for {@link PhotoColorLabel}. Useful for validation. */
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

export interface PhotoMetadata {
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
  takenAt: string | null;
  location: { lat: number; lng: number } | null;
  cameraMake: string | null;
  cameraModel: string | null;
}

export interface Photo {
  id: string;
  libraryId: string;
  albumIds: string[];
  originalName: string;
  storagePath: string;
  thumbnailPath: string | null;
  status: PhotoStatus;
  metadata: PhotoMetadata | null;
  createdAt: string;
  updatedAt: string;
  isFavorite: boolean;
  tags: string[];
  /**
   * Lightroom-style triage rating, 0–5 stars. Defaults to 0 (unset).
   */
  rating: PhotoRating;
  /**
   * Lightroom-style pick/reject flag. `null` (default) means unflagged.
   */
  flag: PhotoFlag;
  /**
   * Lightroom-style color label (third triage axis). `null` (default) means
   * no color label is assigned. Issue #184.
   */
  colorLabel: PhotoColorLabel;
}

export interface MetadataFilterInput {
  cameraMake?: string;
  cameraModel?: string;
  hasLocation?: boolean;
  takenAfter?: string;
  takenBefore?: string;
}

export type LibraryQuickCollection = 'favorites' | 'tagged' | 'untagged' | 'recent';

export type LibrarySort = 'created_desc' | 'created_asc' | 'name_asc' | 'name_desc';

export interface ListPhotosInput {
  libraryId: string;
  albumId?: string;
  /**
   * Backward-compatible legacy flag. Prefer `collection: 'favorites'` for new callers.
   */
  favoritesOnly?: boolean;
  /**
   * Optional quick collection filter for reusable views.
   */
  collection?: LibraryQuickCollection;
  tags?: string[];
  metadata?: MetadataFilterInput;
  /**
   * Stable sort conventions for API/UI parity. Defaults to `created_desc`.
   */
  sort?: LibrarySort;
  /**
   * Inclusive minimum rating filter (0–5). Photos with `rating >= minRating` match.
   */
  minRating?: PhotoRating;
  /**
   * Filter by triage flag. Use `'unflagged'` to request rows with `flag === null`.
   */
  flag?: PhotoFlag | 'unflagged';
  /**
   * Filter by color label (issue #184). Pass one or more values to match any of them
   * (OR semantics). Use `'uncolored'` to request rows with `colorLabel === null`.
   */
  colorLabel?: PhotoColorLabel | 'uncolored' | readonly Exclude<PhotoColorLabel, null>[];
  pageSize?: number;
  pageToken?: string;
}

export interface ListPhotosResult {
  photos: Photo[];
  nextPageToken: string | null;
}

export interface LibraryUsageSummary {
  libraryId: string;
  totalPhotos: number;
  readyPhotos: number;
  favoritePhotos: number;
  taggedPhotos: number;
  totalBytes: number;
}

export interface AddPhotoInput {
  libraryId: string;
  originalName: string;
  /** base64 data URL or object URL — adapter resolves to its storage path */
  dataUrl: string;
  metadata?: Partial<PhotoMetadata>;
}

export interface UpdatePhotoInput {
  isFavorite?: boolean;
  tags?: string[];
  albumIds?: string[];
  /** Triage rating (0–5). Validated by the service. */
  rating?: PhotoRating;
  /** Triage flag (`'pick' | 'reject' | null`). Validated by the service. */
  flag?: PhotoFlag;
  /**
   * Triage color label (`'red' | 'yellow' | 'green' | 'blue' | 'purple' | null`).
   * Validated by the service. Issue #184.
   */
  colorLabel?: PhotoColorLabel;
}

export type BulkAddToAlbumErrorCode = 'not_found' | 'already_in_album';

export interface BulkAddToAlbumItemResult {
  photoId: string;
  status: 'added' | 'skipped';
  code?: BulkAddToAlbumErrorCode;
}

export interface BulkAddToAlbumInput {
  libraryId: string;
  albumId: string;
  photoIds: string[];
}

export interface BulkAddToAlbumResult {
  albumId: string;
  results: BulkAddToAlbumItemResult[];
}
