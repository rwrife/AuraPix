export type PhotoStatus = "pending" | "ready" | "error";

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

export interface ListPhotosInput {
  libraryId: string;
  albumId?: string;
  favoritesOnly?: boolean;
  tags?: string[];
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