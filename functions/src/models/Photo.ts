/**
 * Photo domain model with edit versioning
 */

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
}

export interface EditOperation {
  type: 'crop' | 'rotate' | 'adjust' | 'filter';
  params: Record<string, any>;
  order: number;
}

export interface EditVersion {
  version: number;
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
  };
}

export interface Photo {
  id: string;
  libraryId: string;
  albumIds: string[];
  originalName: string;
  storagePaths: StoragePaths;
  metadata: PhotoMetadata;
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
  metadata: PhotoMetadata
): Photo {
  const now = new Date().toISOString();

  return {
    id,
    libraryId,
    albumIds: [],
    originalName,
    storagePaths,
    metadata,
    status: 'uploading',
    currentEditVersion: 0,
    editHistory: [],
    thumbnailsOutdated: false,
    createdAt: now,
    updatedAt: now,
  };
}