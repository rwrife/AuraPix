import { useCallback, useEffect, useState } from 'react';
import type { AlbumsService } from '../../domain/albums/contract';
import type { Album } from '../../domain/albums/types';

interface UseAlbumsResult {
  albums: Album[];
  loading: boolean;
  error: string | null;
  createAlbum(name: string): Promise<void>;
}

export function useAlbums(albumsService: AlbumsService): UseAlbumsResult {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAlbums() {
      try {
        const nextAlbums = await albumsService.listAlbums();
        if (!cancelled) {
          setAlbums(nextAlbums);
        }
      } catch {
        if (!cancelled) {
          setError('Unable to load albums.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadAlbums();

    return () => {
      cancelled = true;
    };
  }, [albumsService]);

  const createAlbum = useCallback(
    async (name: string) => {
      setError(null);
      try {
        const created = await albumsService.createAlbum({ name });
        setAlbums((current) => [created, ...current]);
      } catch (err) {
        if (err instanceof Error) {
          setError(err.message);
          return;
        }
        setError('Unable to create album.');
      }
    },
    [albumsService],
  );

  return {
    albums,
    loading,
    error,
    createAlbum,
  };
}
