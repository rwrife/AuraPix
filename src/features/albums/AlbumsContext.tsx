import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Album, AlbumFolder } from '../../domain/albums/types';
import { useServices } from '../../services/useServices';

export interface AlbumsState {
  albums: Album[];
  folders: AlbumFolder[];
  loading: boolean;
  error: string | null;
  createAlbum(name: string, folderId?: string | null): Promise<Album | null>;
  renameAlbum(albumId: string, name: string): Promise<void>;
  deleteAlbum(albumId: string): Promise<void>;
  createFolder(name: string): Promise<void>;
  renameFolder(folderId: string, name: string): Promise<void>;
  deleteFolder(folderId: string): Promise<void>;
  moveAlbum(albumId: string, folderId: string | null): Promise<void>;
}

const AlbumsContext = createContext<AlbumsState | null>(null);

export function AlbumsProvider({ children }: { children: ReactNode }) {
  const { albums: albumsService } = useServices();
  const [albums, setAlbums] = useState<Album[]>([]);
  const [folders, setFolders] = useState<AlbumFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    console.log('[AlbumsContext] Starting to load albums and folders...');
    Promise.all([albumsService.listAlbums(), albumsService.listFolders()])
      .then(([a, f]) => {
        console.log('[AlbumsContext] Successfully loaded:', { albums: a.length, folders: f.length });
        console.log('[AlbumsContext] Albums:', a);
        console.log('[AlbumsContext] Folders:', f);
        if (!cancelled) {
          setAlbums(a);
          setFolders(f);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('[AlbumsContext] Error loading albums:', err);
        if (!cancelled) {
          setError('Unable to load albums.');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [albumsService]);

  const createAlbum = useCallback(
    async (name: string, folderId?: string | null): Promise<Album | null> => {
      setError(null);
      try {
        const created = await albumsService.createAlbum({ name, folderId });
        setAlbums((prev) => [created, ...prev]);
        return created;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to create album.');
        return null;
      }
    },
    [albumsService]
  );

  const deleteAlbum = useCallback(
    async (albumId: string) => {
      setError(null);
      try {
        await albumsService.deleteAlbum(albumId);
        setAlbums((prev) => prev.filter((a) => a.id !== albumId));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to delete album.');
      }
    },
    [albumsService]
  );

  const renameAlbum = useCallback(
    async (albumId: string, name: string) => {
      setError(null);
      try {
        const updated = await albumsService.updateAlbum(albumId, { name });
        setAlbums((prev) => prev.map((a) => (a.id === albumId ? updated : a)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to rename album.');
      }
    },
    [albumsService]
  );

  const createFolder = useCallback(
    async (name: string) => {
      setError(null);
      try {
        const created = await albumsService.createFolder({ name });
        setFolders((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to create folder.');
      }
    },
    [albumsService]
  );

  const deleteFolder = useCallback(
    async (folderId: string) => {
      setError(null);
      try {
        await albumsService.deleteFolder(folderId);
        setFolders((prev) => prev.filter((f) => f.id !== folderId));
        setAlbums((prev) =>
          prev.map((a) => (a.folderId === folderId ? { ...a, folderId: null } : a))
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to delete folder.');
      }
    },
    [albumsService]
  );

  const renameFolder = useCallback(
    async (folderId: string, name: string) => {
      setError(null);
      try {
        const updated = await albumsService.updateFolder(folderId, { name });
        setFolders((prev) =>
          prev
            .map((f) => (f.id === folderId ? updated : f))
            .sort((a, b) => a.name.localeCompare(b.name))
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to rename folder.');
      }
    },
    [albumsService]
  );

  const moveAlbum = useCallback(
    async (albumId: string, folderId: string | null) => {
      setError(null);
      try {
        const updated = await albumsService.updateAlbum(albumId, { folderId });
        setAlbums((prev) => prev.map((a) => (a.id === albumId ? updated : a)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to move album.');
      }
    },
    [albumsService]
  );

  return (
    <AlbumsContext.Provider
      value={{
        albums,
        folders,
        loading,
        error,
        createAlbum,
        renameAlbum,
        deleteAlbum,
        createFolder,
        renameFolder,
        deleteFolder,
        moveAlbum,
      }}
    >
      {children}
    </AlbumsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAlbums(): AlbumsState {
  const ctx = useContext(AlbumsContext);
  if (!ctx) throw new Error('useAlbums must be used within an AlbumsProvider');
  return ctx;
}
