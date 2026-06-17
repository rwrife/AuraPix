import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSmartAlbums } from '../features/smartAlbums/SmartAlbumsContext';
import type { SmartAlbum } from '../domain/smartAlbums/types';
import type { SmartAlbumPhoto } from '../domain/smartAlbums/contract';

// ---------------------------------------------------------------------------
// SmartAlbumPage \u2014 view a smart album by id (issue #165).
// Materializes the album by re-running its filter against the photos
// service via `useSmartAlbums().service.materialize(id)`. Photos are
// rendered as a simple summary grid; this page is read-only by design
// (smart albums cannot be manually curated).
// ---------------------------------------------------------------------------

export function SmartAlbumPage() {
  const { id } = useParams<{ id: string }>();
  const { smartAlbums, service, loading: listLoading } = useSmartAlbums();
  const [album, setAlbum] = useState<SmartAlbum | null>(null);
  const [photos, setPhotos] = useState<SmartAlbumPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    if (!id) return;

    async function load() {
      setBusy(true);
      setError(null);
      try {
        const meta = smartAlbums.find((a) => a.id === id) ?? (await service.get(id!));
        if (cancelled) return;
        setAlbum(meta);
        if (meta) {
          const result = await service.materialize(id!);
          if (cancelled) return;
          setPhotos(result.photos);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load smart album.');
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [id, service, smartAlbums]);

  if (!id) {
    return <p>Missing smart album id.</p>;
  }

  if (busy || listLoading) {
    return <p>Loading smart album&hellip;</p>;
  }

  if (error) {
    return (
      <div role="alert" className="error-banner">
        {error}
      </div>
    );
  }

  if (!album) {
    return (
      <div className="empty-state">
        <p>Smart album not found.</p>
        <Link to="/library">Back to library</Link>
      </div>
    );
  }

  return (
    <section className="smart-album-page">
      <header>
        <h1>{album.name}</h1>
        <p className="smart-album-summary">
          Smart album \u2014 contents are computed from a saved filter and update
          automatically.
        </p>
      </header>
      {photos.length === 0 ? (
        <p className="empty-state">No photos match this smart album yet.</p>
      ) : (
        <ul className="photo-grid">
          {photos.map((photo) => (
            <li key={photo.id} className="photo-grid-item">
              <span className="photo-original-name">{photo.originalName}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
