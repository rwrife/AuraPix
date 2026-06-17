import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { SmartAlbumsService } from '../../domain/smartAlbums/contract';
import type {
  CreateSmartAlbumInput,
  SmartAlbum,
  UpdateSmartAlbumInput,
} from '../../domain/smartAlbums/types';
import { useServices } from '../../services/useServices';

// ---------------------------------------------------------------------------
// SmartAlbums feature provider (issue #165).
//
// Smart Albums are saved filters; their contents materialize on read against
// the photos service. This context only manages metadata (name + filter +
// listing); use `service.materialize(id)` directly when rendering a smart
// album's photo grid.
// ---------------------------------------------------------------------------

export interface SmartAlbumsState {
  smartAlbums: SmartAlbum[];
  loading: boolean;
  error: string | null;
  reload(): Promise<void>;
  createSmartAlbum(input: CreateSmartAlbumInput): Promise<SmartAlbum | null>;
  updateSmartAlbum(id: string, updates: UpdateSmartAlbumInput): Promise<SmartAlbum | null>;
  deleteSmartAlbum(id: string): Promise<void>;
  service: SmartAlbumsService;
}

const SmartAlbumsContext = createContext<SmartAlbumsState | null>(null);

const DEFAULT_LIBRARY_ID = 'library-local-user-1';

export function SmartAlbumsProvider({
  children,
  libraryId = DEFAULT_LIBRARY_ID,
}: {
  children: ReactNode;
  libraryId?: string;
}) {
  const { smartAlbums: service } = useServices();
  const [smartAlbums, setSmartAlbums] = useState<SmartAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await service.listByLibrary(libraryId);
      setSmartAlbums(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load smart albums.');
    } finally {
      setLoading(false);
    }
  }, [service, libraryId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createSmartAlbum = useCallback(
    async (input: CreateSmartAlbumInput): Promise<SmartAlbum | null> => {
      setError(null);
      try {
        const created = await service.create(input);
        setSmartAlbums((prev) => [created, ...prev]);
        return created;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to create smart album.');
        return null;
      }
    },
    [service]
  );

  const updateSmartAlbum = useCallback(
    async (id: string, updates: UpdateSmartAlbumInput): Promise<SmartAlbum | null> => {
      setError(null);
      try {
        const updated = await service.update(id, updates);
        setSmartAlbums((prev) => prev.map((a) => (a.id === id ? updated : a)));
        return updated;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to update smart album.');
        return null;
      }
    },
    [service]
  );

  const deleteSmartAlbum = useCallback(
    async (id: string): Promise<void> => {
      setError(null);
      try {
        await service.remove(id);
        setSmartAlbums((prev) => prev.filter((a) => a.id !== id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to delete smart album.');
      }
    },
    [service]
  );

  const value = useMemo<SmartAlbumsState>(
    () => ({
      smartAlbums,
      loading,
      error,
      reload,
      createSmartAlbum,
      updateSmartAlbum,
      deleteSmartAlbum,
      service,
    }),
    [
      smartAlbums,
      loading,
      error,
      reload,
      createSmartAlbum,
      updateSmartAlbum,
      deleteSmartAlbum,
      service,
    ]
  );

  return <SmartAlbumsContext.Provider value={value}>{children}</SmartAlbumsContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSmartAlbums(): SmartAlbumsState {
  const ctx = useContext(SmartAlbumsContext);
  if (!ctx) {
    throw new Error('useSmartAlbums must be used within a <SmartAlbumsProvider>.');
  }
  return ctx;
}
