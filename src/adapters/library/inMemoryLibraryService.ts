import type { LibraryService } from '../../domain/library/contract';
import type {
  AddPhotoInput,
  BulkAddToAlbumInput,
  BulkAddToAlbumResult,
  ListPhotosInput,
  ListPhotosResult,
  LibraryQuickCollection,
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

interface InMemoryLibraryServiceOptions {
  seed?: Photo[];
  /**
   * Optional hard quota per library in bytes. Omit/undefined to disable quotas.
   */
  quotaBytesByLibraryId?: Record<string, number>;
}

function applyCollectionFilter(photos: Photo[], collection?: LibraryQuickCollection): Photo[] {
  if (!collection) {
    return photos;
  }

  if (collection === 'favorites') {
    return photos.filter((photo) => photo.isFavorite);
  }

  if (collection === 'tagged') {
    return photos.filter((photo) => photo.tags.length > 0);
  }

  if (collection === 'untagged') {
    return photos.filter((photo) => photo.tags.length === 0);
  }

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return photos.filter((photo) => {
    const createdAt = Date.parse(photo.createdAt);
    return !Number.isNaN(createdAt) && createdAt >= thirtyDaysAgo;
  });
}

export class InMemoryLibraryService implements LibraryService {
  private photos: Photo[];
  private readonly quotaBytesByLibraryId: Record<string, number>;

  constructor(options: InMemoryLibraryServiceOptions = {}) {
    const stored = loadPhotos();
    this.photos = stored.length > 0 ? stored : [...(options.seed ?? [])];
    this.quotaBytesByLibraryId = options.quotaBytesByLibraryId ?? {};
  }

  async listPhotos(input: ListPhotosInput): Promise<ListPhotosResult> {
    let results = this.photos.filter(
      (p) => p.libraryId === input.libraryId && p.status === 'ready'
    );

    if (input.albumId) {
      results = results.filter((p) => p.albumIds.includes(input.albumId!));
    }
    results = applyCollectionFilter(results, input.collection);

    if (input.favoritesOnly) {
      // Backward compatibility for legacy callers.
      results = results.filter((p) => p.isFavorite);
    }
    if (input.tags && input.tags.length > 0) {
      results = results.filter((p) => input.tags!.every((t) => p.tags.includes(t)));
    }

    if (input.metadata?.cameraMake) {
      const cameraMake = input.metadata.cameraMake.trim().toLowerCase();
      results = results.filter((p) => p.metadata?.cameraMake?.toLowerCase() === cameraMake);
    }

    if (input.metadata?.cameraModel) {
      const cameraModel = input.metadata.cameraModel.trim().toLowerCase();
      results = results.filter((p) => p.metadata?.cameraModel?.toLowerCase() === cameraModel);
    }

    if (input.metadata?.hasLocation !== undefined) {
      results = results.filter(
        (p) => (p.metadata?.location !== null) === input.metadata?.hasLocation
      );
    }

    if (input.metadata?.takenAfter) {
      const after = Date.parse(input.metadata.takenAfter);
      if (!Number.isNaN(after)) {
        results = results.filter((p) => {
          const takenAt = p.metadata?.takenAt ? Date.parse(p.metadata.takenAt) : Number.NaN;
          return !Number.isNaN(takenAt) && takenAt >= after;
        });
      }
    }

    if (input.metadata?.takenBefore) {
      const before = Date.parse(input.metadata.takenBefore);
      if (!Number.isNaN(before)) {
        results = results.filter((p) => {
          const takenAt = p.metadata?.takenAt ? Date.parse(p.metadata.takenAt) : Number.NaN;
          return !Number.isNaN(takenAt) && takenAt <= before;
        });
      }
    }

    // Sort newest-first
    results = results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const pageSize = input.pageSize ?? results.length;
    const startIndex = input.pageToken
      ? Math.max(
          0,
          (() => {
            const tokenIndex = results.findIndex((p) => p.id === input.pageToken);
            return tokenIndex === -1 ? 0 : tokenIndex;
          })()
        )
      : 0;
    const page = results.slice(startIndex, startIndex + pageSize);
    const nextPageToken =
      startIndex + pageSize < results.length ? results[startIndex + pageSize].id : null;

    return { photos: page, nextPageToken };
  }

  async getPhoto(photoId: string): Promise<Photo | null> {
    return this.photos.find((p) => p.id === photoId) ?? null;
  }

  private calculateLibraryUsageBytes(libraryId: string): number {
    return this.photos
      .filter((photo) => photo.libraryId === libraryId)
      .reduce((total, photo) => total + (photo.metadata?.sizeBytes ?? 0), 0);
  }

  async addPhoto(input: AddPhotoInput): Promise<Photo> {
    const incomingSizeBytes = input.metadata?.sizeBytes ?? 0;
    const configuredQuota = this.quotaBytesByLibraryId[input.libraryId];

    if (configuredQuota !== undefined) {
      const usedBytes = this.calculateLibraryUsageBytes(input.libraryId);
      if (usedBytes + incomingSizeBytes > configuredQuota) {
        const formatMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        throw new Error(
          `Storage quota exceeded for this library (${formatMb(usedBytes)} used of ${formatMb(configuredQuota)}).`
        );
      }
    }

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

  async bulkAddToAlbum(input: BulkAddToAlbumInput): Promise<BulkAddToAlbumResult> {
    const results: BulkAddToAlbumResult['results'] = [];

    for (const photoId of input.photoIds) {
      const idx = this.photos.findIndex((p) => p.id === photoId && p.libraryId === input.libraryId);
      if (idx === -1) {
        results.push({ photoId, status: 'skipped', code: 'not_found' });
        continue;
      }

      const photo = this.photos[idx];
      if (photo.albumIds.includes(input.albumId)) {
        results.push({ photoId, status: 'skipped', code: 'already_in_album' });
        continue;
      }

      this.photos[idx] = {
        ...photo,
        albumIds: [...photo.albumIds, input.albumId],
        updatedAt: new Date().toISOString(),
      };
      results.push({ photoId, status: 'added' });
    }

    savePhotos(this.photos);
    return { albumId: input.albumId, results };
  }
}
