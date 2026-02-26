import type { LibraryService } from '../../domain/library/contract';
import type {
  AddPhotoInput,
  ListPhotosInput,
  ListPhotosResult,
  Photo,
  UpdatePhotoInput,
} from '../../domain/library/types';

// ---------------------------------------------------------------------------
// In-memory library service with localStorage persistence.
// Photos are stored as data URLs so they survive page refresh locally.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'aurapix:local:photos';

function loadPhotos(): Photo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Photo[]) : [];
  } catch {
    return [];
  }
}

function savePhotos(photos: Photo[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(photos));
  } catch {
    // Storage quota exceeded — continue in-memory only
  }
}

export class InMemoryLibraryService implements LibraryService {
  private photos: Photo[];

  constructor(seed: Photo[] = []) {
    const stored = loadPhotos();
    this.photos = stored.length > 0 ? stored : [...seed];
  }

  async listPhotos(input: ListPhotosInput): Promise<ListPhotosResult> {
    let results = this.photos.filter(
      (p) => p.libraryId === input.libraryId && p.status === 'ready'
    );

    if (input.albumId) {
      results = results.filter((p) => p.albumIds.includes(input.albumId!));
    }
    if (input.favoritesOnly) {
      results = results.filter((p) => p.isFavorite);
    }
    if (input.tags && input.tags.length > 0) {
      results = results.filter((p) => input.tags!.every((t) => p.tags.includes(t)));
    }

    // Sort newest-first
    results = results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const pageSize = input.pageSize ?? results.length;
    const startIndex = input.pageToken ? results.findIndex((p) => p.id === input.pageToken) : 0;
    const page = results.slice(startIndex, startIndex + pageSize);
    const nextPageToken =
      startIndex + pageSize < results.length ? results[startIndex + pageSize].id : null;

    return { photos: page, nextPageToken };
  }

  async getPhoto(photoId: string): Promise<Photo | null> {
    return this.photos.find((p) => p.id === photoId) ?? null;
  }

  async addPhoto(input: AddPhotoInput): Promise<Photo> {
    const now = new Date().toISOString();
    const id = `photo-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    const photo: Photo = {
      id,
      libraryId: input.libraryId,
      albumIds: [],
      originalName: input.originalName,
      storagePath: input.dataUrl,
      thumbnailPath: input.dataUrl,
      status: 'ready',
      metadata: input.metadata
        ? {
            width: input.metadata.width ?? 0,
            height: input.metadata.height ?? 0,
            mimeType: input.metadata.mimeType ?? 'image/jpeg',
            sizeBytes: input.metadata.sizeBytes ?? 0,
            takenAt: input.metadata.takenAt ?? null,
            location: input.metadata.location ?? null,
            cameraMake: input.metadata.cameraMake ?? null,
            cameraModel: input.metadata.cameraModel ?? null,
          }
        : null,
      createdAt: now,
      updatedAt: now,
      isFavorite: false,
      tags: [],
    };

    this.photos = [photo, ...this.photos];
    savePhotos(this.photos);
    return photo;
  }

  async updatePhoto(photoId: string, input: UpdatePhotoInput): Promise<Photo> {
    const idx = this.photos.findIndex((p) => p.id === photoId);
    if (idx === -1) throw new Error(`Photo ${photoId} not found.`);

    const updated: Photo = {
      ...this.photos[idx],
      ...(input.isFavorite !== undefined && { isFavorite: input.isFavorite }),
      ...(input.tags !== undefined && { tags: input.tags }),
      ...(input.albumIds !== undefined && { albumIds: input.albumIds }),
      updatedAt: new Date().toISOString(),
    };

    this.photos = [...this.photos.slice(0, idx), updated, ...this.photos.slice(idx + 1)];
    savePhotos(this.photos);
    return updated;
  }

  async deletePhoto(photoId: string): Promise<void> {
    this.photos = this.photos.filter((p) => p.id !== photoId);
    savePhotos(this.photos);
  }
}
