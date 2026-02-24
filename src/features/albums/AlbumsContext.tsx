import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Album, AlbumFolder } from "../../domain/albums/types";
import { useServices } from "../../services/useServices";

export interface AlbumsState {
  albums: Album[];
  folders: AlbumFolder[];
  loading: boolean;
  error: string | null;
  createAlbum(name: string, folderId?: string | null): Promise<void>;
  deleteAlbum(albumId: string): Promise<void>;
  createFolder(name: string): Promise<void>;
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
    Promise.all([albumsService.listAlbums(), albumsService.listFolders()])
      .then(([a, f]) => {
        if (!cancelled) {
          setAlbums(a);
          setFolders(f);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Unable to load albums.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [albumsService]);

  const createAlbum = useCallback(
    async (name: string, folderId?: string | null) => {
      setError(null);
      try {
        const created = await albumsService.createAlbum({ name, folderId });
        setAlbums((prev) => [created, ...prev]);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Unable to create album.",
        );
      }
    },
    [albumsService],
  );

  const deleteAlbum = useCallback(
    async (albumId: string) => {
      setError(null);
      try {
        await albumsService.deleteAlbum(albumId);
        setAlbums((prev) => prev.filter((a) => a.id !== albumId));
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Unable to delete album.",
        );
      }
    },
    [albumsService],
  );

  const createFolder = useCallback(
    async (name: string) => {
      setError(null);
      try {
        const created = await albumsService.createFolder({ name });
        setFolders((prev) =>
          [...prev, created].sort((a, b) => a.name.localeCompare(b.name)),
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Unable to create folder.",
        );
      }
    },
    [albumsService],
  );

  const deleteFolder = useCallback(
    async (folderId: string) => {
      setError(null);
      try {
        await albumsService.deleteFolder(folderId);
        setFolders((prev) => prev.filter((f) => f.id !== folderId));
        setAlbums((prev) =>
          prev.map((a) =>
            a.folderId === folderId ? { ...a, folderId: null } : a,
          ),
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Unable to delete folder.",
        );
      }
    },
    [albumsService],
  );

  const moveAlbum = useCallback(
    async (albumId: string, folderId: string | null) => {
      setError(null);
      try {
        const updated = await albumsService.updateAlbum(albumId, { folderId });
        setAlbums((prev) => prev.map((a) => (a.id === albumId ? updated : a)));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to move album.");
      }
    },
    [albumsService],
  );

  return (
    <AlbumsContext.Provider
      value={{
        albums,
        folders,
        loading,
        error,
        createAlbum,
        deleteAlbum,
        createFolder,
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
  if (!ctx)
    throw new Error("useAlbums must be used within an AlbumsProvider");
  return ctx;
}