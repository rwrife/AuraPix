import { useCallback, useEffect, useState } from 'react';
import type { BulkAddToAlbumResult, MetadataFilterInput, Photo } from '../../domain/library/types';
import { useServices } from '../../services/useServices';

interface UseLibraryState {
  photos: Photo[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
}

interface UseLibraryReturn extends UseLibraryState {
  refresh(): void;
  loadMore(): Promise<void>;
  addPhoto(file: File): Promise<Photo>;
  toggleFavorite(photoId: string): Promise<void>;
  setTags(photoId: string, tags: string[]): Promise<void>;
  deletePhoto(photoId: string): Promise<void>;
  assignToAlbum(photoId: string, albumId: string, hint?: Photo): Promise<void>;
  bulkAddToAlbum(photoIds: string[], albumId: string): Promise<BulkAddToAlbumResult>;
}

/** Reads a File into a base64 data URL */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function useLibrary(
  libraryId: string,
  filters?: { metadata?: MetadataFilterInput; favoritesOnly?: boolean; tags?: string[] }
): UseLibraryReturn {
  const { library } = useServices();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    library
      .listPhotos({
        libraryId,
        metadata: filters?.metadata,
        favoritesOnly: filters?.favoritesOnly,
        tags: filters?.tags,
        pageSize: 24,
      })
      .then(({ photos: p, nextPageToken: token }) => {
        if (!cancelled) {
          setPhotos(p);
          setNextPageToken(token);
          setHasMore(token !== null);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load photos.');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [library, libraryId, tick, filters?.metadata, filters?.favoritesOnly, filters?.tags]);

  const addPhoto = useCallback(
    async (file: File): Promise<Photo> => {
      const dataUrl = await readFileAsDataUrl(file);
      const photo = await library.addPhoto({
        libraryId,
        originalName: file.name,
        dataUrl,
        metadata: {
          mimeType: file.type,
          sizeBytes: file.size,
        },
      });
      refresh();
      return photo;
    },
    [library, libraryId, refresh]
  );

  const toggleFavorite = useCallback(
    async (photoId: string) => {
      const photo = photos.find((p) => p.id === photoId);
      if (!photo) return;
      const updated = await library.updatePhoto(photoId, {
        isFavorite: !photo.isFavorite,
      });
      setPhotos((prev) => prev.map((p) => (p.id === photoId ? updated : p)));
    },
    [library, photos]
  );

  const setTags = useCallback(
    async (photoId: string, tags: string[]) => {
      const updated = await library.updatePhoto(photoId, { tags });
      setPhotos((prev) => prev.map((p) => (p.id === photoId ? updated : p)));
    },
    [library]
  );

  const deletePhoto = useCallback(
    async (photoId: string) => {
      await library.deletePhoto(photoId);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
    },
    [library]
  );

  const assignToAlbum = useCallback(
    async (photoId: string, albumId: string, hint?: Photo) => {
      const photo = hint ?? photos.find((p) => p.id === photoId);
      if (!photo) return;
      const albumIds = photo.albumIds.includes(albumId)
        ? photo.albumIds
        : [...photo.albumIds, albumId];
      const updated = await library.updatePhoto(photoId, { albumIds });
      setPhotos((prev) => prev.map((p) => (p.id === photoId ? updated : p)));
    },
    [library, photos]
  );

  const bulkAddToAlbum = useCallback(
    async (photoIds: string[], albumId: string) => {
      const result = await library.bulkAddToAlbum({
        libraryId,
        albumId,
        photoIds,
      });

      const addedIds = new Set(
        result.results.filter((item) => item.status === 'added').map((item) => item.photoId)
      );

      if (addedIds.size > 0) {
        setPhotos((prev) =>
          prev.map((photo) =>
            addedIds.has(photo.id) && !photo.albumIds.includes(albumId)
              ? {
                  ...photo,
                  albumIds: [...photo.albumIds, albumId],
                  updatedAt: new Date().toISOString(),
                }
              : photo
          )
        );
      }

      return result;
    },
    [library, libraryId]
  );

  const loadMore = useCallback(async () => {
    if (!nextPageToken || loadingMore) return;

    setLoadingMore(true);
    try {
      const { photos: morePhotos, nextPageToken: token } = await library.listPhotos({
        libraryId,
        metadata: filters?.metadata,
        favoritesOnly: filters?.favoritesOnly,
        tags: filters?.tags,
        pageSize: 24,
        pageToken: nextPageToken,
      });

      setPhotos((prev) => [...prev, ...morePhotos]);
      setNextPageToken(token);
      setHasMore(token !== null);
    } finally {
      setLoadingMore(false);
    }
  }, [
    nextPageToken,
    loadingMore,
    library,
    libraryId,
    filters?.metadata,
    filters?.favoritesOnly,
    filters?.tags,
  ]);

  return {
    photos,
    loading,
    error,
    hasMore,
    loadingMore,
    refresh,
    loadMore,
    addPhoto,
    toggleFavorite,
    setTags,
    deletePhoto,
    assignToAlbum,
    bulkAddToAlbum,
  };
}
