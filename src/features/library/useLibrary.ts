import { useCallback, useEffect, useState } from 'react';
import type { Photo } from '../../domain/library/types';
import { useServices } from '../../services/useServices';

interface UseLibraryState {
  photos: Photo[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
}

interface UseLibraryReturn extends UseLibraryState {
  refresh(): void;
  addPhoto(file: File): Promise<Photo>;
  toggleFavorite(photoId: string): Promise<void>;
  deletePhoto(photoId: string): Promise<void>;
  assignToAlbum(photoId: string, albumId: string, hint?: Photo): Promise<void>;
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

export function useLibrary(libraryId: string): UseLibraryReturn {
  const { library } = useServices();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    library
      .listPhotos({ libraryId })
      .then(({ photos: p, nextPageToken }) => {
        if (!cancelled) {
          setPhotos(p);
          setHasMore(nextPageToken !== null);
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
  }, [library, libraryId, tick]);

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

  return {
    photos,
    loading,
    error,
    hasMore,
    refresh,
    addPhoto,
    toggleFavorite,
    deletePhoto,
    assignToAlbum,
  };
}
