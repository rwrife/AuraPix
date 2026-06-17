import type {
  CreateSmartAlbumInput,
  SmartAlbum,
  UpdateSmartAlbumInput,
} from './types';

export interface MaterializeOptions {
  pageSize?: number;
  pageToken?: string | null;
}

export interface SmartAlbumPhoto {
  id: string;
  libraryId: string;
  originalName: string;
  status: string;
  metadata: {
    width?: number | null;
    height?: number | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    takenAt?: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface MaterializeResult {
  photos: SmartAlbumPhoto[];
  nextPageToken: string | null;
  total: number;
}

export interface SmartAlbumsService {
  listByLibrary(libraryId: string): Promise<SmartAlbum[]>;
  get(id: string): Promise<SmartAlbum | null>;
  create(input: CreateSmartAlbumInput): Promise<SmartAlbum>;
  update(id: string, updates: UpdateSmartAlbumInput): Promise<SmartAlbum>;
  remove(id: string): Promise<void>;
  materialize(id: string, opts?: MaterializeOptions): Promise<MaterializeResult>;
}
