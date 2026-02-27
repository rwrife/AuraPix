export type PhotoStatus = 'pending' | 'ready' | 'error';

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
}

export interface MetadataFilterInput {
  cameraMake?: string;
  cameraModel?: string;
  hasLocation?: boolean;
  takenAfter?: string;
  takenBefore?: string;
}

export type LibraryQuickCollection = 'favorites' | 'tagged' | 'untagged' | 'recent';

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
  pageSize?: number;
  pageToken?: string;
}

export interface ListPhotosResult {
  photos: Photo[];
  nextPageToken: string | null;
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
