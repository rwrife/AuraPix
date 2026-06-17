// ---------------------------------------------------------------------------
// Smart Albums — frontend types. Mirror the validated DSL on the backend
// (see functions/src/domain/smartAlbums). Strict shape: the UI must not
// invent unknown fields; the API rejects them with `SMART_ALBUM_INVALID_FILTER`.
// ---------------------------------------------------------------------------

export type SmartAlbumFlag = 'pick' | 'reject';

export interface SmartAlbumFilter {
  rating?: { gte?: number; lte?: number };
  flag?: SmartAlbumFlag;
  tags?: string[];
  capturedBetween?: [string, string];
  mimeTypes?: string[];
}

export interface SmartAlbum {
  id: string;
  tenantId: string;
  libraryId: string;
  ownerId: string;
  name: string;
  filter: SmartAlbumFilter;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSmartAlbumInput {
  libraryId: string;
  name: string;
  filter: SmartAlbumFilter;
}

export interface UpdateSmartAlbumInput {
  name?: string;
  filter?: SmartAlbumFilter;
}
