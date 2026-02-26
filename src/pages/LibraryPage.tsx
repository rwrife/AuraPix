import { useEffect, useRef, useState, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PhotoGallery } from '../components/PhotoGallery';
import { GRID_BUTTONS, type GridMode } from '../components/photoGalleryConfig';
import type { ViewerState } from '../components/PhotoViewer';
import { UploadModal } from '../components/UploadModal';
import { Toolbar } from '../components/toolbar';
import { ViewerToolbar } from '../components/toolbar';
import { createViewerToolbarConfig } from '../components/toolbar/examples/viewerToolbarConfig';
import type { ToolbarButton, ModalContentProps } from '../components/toolbar';
import { useAuth } from '../features/auth/useAuth';
import { useAlbums } from '../features/albums/useAlbums';
import { useLibrary } from '../features/library/useLibrary';
import {
  loadQuickViewPreferences,
  saveQuickViewPreferences,
} from '../features/library/quickViewPreferences';
import { useUploadSessions } from '../features/uploads/useUploadSessions';
import { useServices } from '../services/useServices';

function toLibraryId(userId: string) {
  return `library-${userId}`;
}

export function LibraryPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const libraryId = toLibraryId(user?.id ?? 'local-user-1');
  const initialQuickViewPreferences = useMemo(
    () => loadQuickViewPreferences(libraryId),
    [libraryId]
  );
  const [cameraMakeFilter, setCameraMakeFilter] = useState<string>(
    initialQuickViewPreferences.cameraMakeFilter
  );
  const [quickCollection, setQuickCollection] = useState<
    'all' | 'favorites' | 'untagged' | 'recent'
  >(initialQuickViewPreferences.quickCollection);
  const [activeTagFilter, setActiveTagFilter] = useState<string>(
    initialQuickViewPreferences.activeTagFilter
  );
  const [gridMode, setGridMode] = useState<GridMode>(initialQuickViewPreferences.gridMode);
  const metadataFilters = useMemo(
    () => ({
      metadata: cameraMakeFilter ? { cameraMake: cameraMakeFilter } : undefined,
      favoritesOnly: quickCollection === 'favorites',
      collection: quickCollection === 'all' ? undefined : quickCollection,
      tags: activeTagFilter ? [activeTagFilter] : undefined,
    }),
    [cameraMakeFilter, quickCollection, activeTagFilter]
  );

  useEffect(() => {
    saveQuickViewPreferences(libraryId, {
      quickCollection,
      activeTagFilter,
      cameraMakeFilter,
      gridMode,
    });
  }, [libraryId, quickCollection, activeTagFilter, cameraMakeFilter, gridMode]);

  const {
    photos,
    loading,
    error,
    hasMore,
    loadingMore,
    loadMore,
    addPhoto,
    assignToAlbum,
    bulkAddToAlbum,
    toggleFavorite,
    setTags,
    deletePhoto,
  } = useLibrary(libraryId, metadataFilters);
  const { albums } = useAlbums();
  const { uploads: uploadSessionsService } = useServices();
  const {
    pendingSession,
    metadata: uploadedMetadata,
    jobs: derivativeJobs,
    replayedFinalize,
    createAndFinalizeSession,
    processNextDerivativeJob,
  } = useUploadSessions(uploadSessionsService);

  const [isFilmstrip, setIsFilmstrip] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
  const [bulkAlbumId, setBulkAlbumId] = useState<string>('');
  const [bulkTagInput, setBulkTagInput] = useState<string>('');
  const [bulkActionMessage, setBulkActionMessage] = useState<string | null>(null);
  const viewerStateRef = useRef<ViewerState | null>(null);
  const [viewerState, setViewerState] = useState<ViewerState | null>(null);

  // Sync viewer state for rendering
  useEffect(() => {
    if (!isFilmstrip) {
      setViewerState(null);
      return;
    }
    // Initial sync
    if (viewerStateRef.current) {
      setViewerState({ ...viewerStateRef.current });
    }
    // Poll for updates
    const interval = setInterval(() => {
      if (viewerStateRef.current) {
        setViewerState({ ...viewerStateRef.current });
      }
    }, 50);
    return () => clearInterval(interval);
  }, [isFilmstrip]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('upload') !== '1') return;

    setShowUploadModal(true);
    params.delete('upload');
    const search = params.toString();
    navigate(
      {
        pathname: '/library',
        search: search ? `?${search}` : '',
      },
      { replace: true }
    );
  }, [location.search, navigate]);

  async function handleUpload(
    files: File[],
    albumId: string | null,
    onProgress: (completed: number, total: number) => void
  ) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      await createAndFinalizeSession(file.name, file.size);

      const photo = await addPhoto(file);
      if (albumId) await assignToAlbum(photo.id, albumId, photo);
      onProgress(i + 1, files.length);
    }
  }

  async function handleBulkAddToAlbum() {
    if (!bulkAlbumId || selectedPhotoIds.size === 0) return;

    const result = await bulkAddToAlbum([...selectedPhotoIds], bulkAlbumId);
    const albumName = albums.find((album) => album.id === bulkAlbumId)?.name ?? 'album';

    const addedCount = result.results.filter((item) => item.status === 'added').length;
    const alreadyInAlbumCount = result.results.filter(
      (item) => item.status === 'skipped' && item.code === 'already_in_album'
    ).length;
    const missingCount = result.results.filter(
      (item) => item.status === 'skipped' && item.code === 'not_found'
    ).length;

    const messageParts = [`Added ${addedCount} photo(s) to “${albumName}”.`];
    if (alreadyInAlbumCount > 0) {
      messageParts.push(`${alreadyInAlbumCount} already in album.`);
    }
    if (missingCount > 0) {
      messageParts.push(`${missingCount} no longer available.`);
    }

    setBulkActionMessage(messageParts.join(' '));
    setSelectedPhotoIds(new Set());
  }

  async function handleBulkTagApply() {
    const nextTag = bulkTagInput.trim().toLowerCase();
    if (!nextTag || selectedPhotoIds.size === 0) return;

    const selectedPhotos = photos.filter((photo) => selectedPhotoIds.has(photo.id));
    for (const photo of selectedPhotos) {
      const normalizedTags = Array.from(
        new Set([...photo.tags.map((tag) => tag.toLowerCase()), nextTag])
      );
      await setTags(photo.id, normalizedTags);
    }

    setBulkActionMessage(`Tagged ${selectedPhotos.length} photo(s) with #${nextTag}.`);
    setBulkTagInput('');
  }

  // Viewer toolbar configuration
  const viewerToolbarButtons = useMemo<ToolbarButton[]>(() => {
    if (!viewerState) return [];

    return createViewerToolbarConfig({
      currentPhoto: viewerState.currentPhoto,
      onToggleFavorite: viewerState.onToggleFavorite,
      onDelete: async () => {
        await deletePhoto(viewerState.currentPhoto.id);
        if (photos.length <= 1) {
          setIsFilmstrip(false);
        }
      },
      brightness: viewerState.brightness,
      setBrightness: viewerState.setBrightness,
      contrast: viewerState.contrast,
      setContrast: viewerState.setContrast,
      saturation: viewerState.saturation,
      setSaturation: viewerState.setSaturation,
    });
  }, [viewerState, deletePhoto, photos.length]);

  const availableTags = useMemo(
    () => [...new Set(photos.flatMap((photo) => photo.tags))].sort((a, b) => a.localeCompare(b)),
    [photos]
  );

  const queuedDerivativeJobs = derivativeJobs.filter((job) => job.status === 'queued').length;
  const completedDerivativeJobs = derivativeJobs.filter((job) => job.status === 'completed').length;

  // Gallery toolbar configuration
  const galleryToolbarButtons = useMemo<ToolbarButton[]>(() => {
    return [
      {
        type: 'toggle',
        id: 'favorite',
        icon: '♥',
        title: 'Toggle favorite',
        disabled: selectedPhotoIds.size === 0,
        onClick: async () => {
          if (selectedPhotoIds.size === 0) return;
          const selectedPhotos = photos.filter((p) => selectedPhotoIds.has(p.id));
          for (const photo of selectedPhotos) {
            await toggleFavorite(photo.id);
          }
          setSelectedPhotoIds(new Set());
        },
      },
      {
        type: 'modal',
        id: 'delete',
        icon: '✕',
        title: 'Delete selected',
        className: 'btn-danger-ghost',
        disabled: selectedPhotoIds.size === 0,
        modalTitle: `Delete ${selectedPhotoIds.size} photo(s)?`,
        modalContent: ({ onClose }: ModalContentProps) => (
          <>
            <p className="state-message">
              This will permanently delete {selectedPhotoIds.size} selected photo(s).
            </p>
            <div className="confirm-modal-actions">
              <button className="btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-danger-ghost"
                onClick={async () => {
                  const selectedPhotos = photos.filter((p) => selectedPhotoIds.has(p.id));
                  for (const photo of selectedPhotos) {
                    await deletePhoto(photo.id);
                  }
                  setSelectedPhotoIds(new Set());
                  onClose();
                }}
              >
                Delete
              </button>
            </div>
          </>
        ),
      },
    ];
  }, [selectedPhotoIds, photos, toggleFavorite, deletePhoto]);

  return (
    <>
      <div className="page-titlebar">
        <h1 className="page-title">Library</h1>
        {!isFilmstrip && photos.length > 0 && (
          <div className="titlebar-controls">
            <button
              className={`btn-ghost btn-sm${quickCollection === 'all' ? ' active' : ''}`}
              title="Show all photos"
              onClick={() => setQuickCollection('all')}
            >
              All
            </button>
            <button
              className={`btn-ghost btn-sm${quickCollection === 'favorites' ? ' active' : ''}`}
              title="Show favorites"
              onClick={() => setQuickCollection('favorites')}
            >
              Favorites
            </button>
            <button
              className={`btn-ghost btn-sm${quickCollection === 'untagged' ? ' active' : ''}`}
              title="Show untagged photos"
              onClick={() => setQuickCollection('untagged')}
            >
              Untagged
            </button>
            <button
              className={`btn-ghost btn-sm${quickCollection === 'recent' ? ' active' : ''}`}
              title="Show recent photos"
              onClick={() => setQuickCollection('recent')}
            >
              Recent
            </button>
            <select
              className="btn-ghost btn-sm"
              aria-label="Filter by tag"
              value={activeTagFilter}
              onChange={(e) => setActiveTagFilter(e.target.value)}
            >
              <option value="">All tags</option>
              {availableTags.map((tag) => (
                <option key={tag} value={tag}>
                  #{tag}
                </option>
              ))}
            </select>
            <select
              className="btn-ghost btn-sm"
              aria-label="Filter by camera make"
              value={cameraMakeFilter}
              onChange={(e) => setCameraMakeFilter(e.target.value)}
            >
              <option value="">All cameras</option>
              {[...new Set(photos.map((photo) => photo.metadata?.cameraMake).filter(Boolean))].map(
                (cameraMake) => (
                  <option key={cameraMake} value={cameraMake ?? ''}>
                    {cameraMake}
                  </option>
                )
              )}
            </select>
            <button
              className="btn-ghost btn-sm"
              title="Select all"
              onClick={() => setSelectedPhotoIds(new Set(photos.map((p) => p.id)))}
            >
              ☑
            </button>
            {GRID_BUTTONS.map(({ mode, icon, title }) => (
              <button
                key={mode}
                className={`btn-ghost btn-sm${gridMode === mode ? ' active' : ''}`}
                title={title}
                onClick={() => setGridMode(mode)}
              >
                {icon}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={`page-with-toolbar${isFilmstrip ? ' page--viewer-mode' : ''}`}>
        <div className="page-center-column">
          {error && <p className="error">{error}</p>}

          {(pendingSession || uploadedMetadata.length > 0) && (
            <div className="state-message" role="status" aria-live="polite">
              <strong>Upload pipeline:</strong> {uploadedMetadata.length} finalized ·{' '}
              {queuedDerivativeJobs} queued · {completedDerivativeJobs} completed
              {pendingSession ? ` · latest key ${pendingSession.objectKey}` : ''}
              {replayedFinalize ? ' · idempotent replay detected' : ''}
              {queuedDerivativeJobs > 0 ? (
                <>
                  {' '}
                  ·{' '}
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => void processNextDerivativeJob()}
                  >
                    Run derivative worker tick
                  </button>
                </>
              ) : (
                ''
              )}
            </div>
          )}

          {loading ? (
            <p className="state-message">Loading library…</p>
          ) : photos.length === 0 ? (
            <div className="empty-state">
              <p>No photos yet.</p>
              <p>
                Click <strong>Add Photos</strong> in the top bar to add images.
              </p>
            </div>
          ) : (
            <PhotoGallery
              photos={photos}
              gridMode={gridMode}
              selectedPhotoIds={selectedPhotoIds}
              onSelectionChange={setSelectedPhotoIds}
              onGridModeChange={setGridMode}
              onIsFilmstripChange={setIsFilmstrip}
              onDeletePhoto={(photo) => deletePhoto(photo.id)}
              onToggleFavorite={(photo) => toggleFavorite(photo.id)}
              viewerStateRef={viewerStateRef}
            />
          )}

          {!loading && hasMore && !isFilmstrip && (
            <div className="pagination-controls">
              <button className="btn-ghost btn-sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
        {isFilmstrip ? (
          viewerState ? (
            <ViewerToolbar buttons={viewerToolbarButtons} ariaLabel="Viewer tools" />
          ) : (
            <aside className="page-right-column" aria-label="Library tools">
              <p className="state-message">Loading tools...</p>
            </aside>
          )
        ) : (
          <Toolbar buttons={galleryToolbarButtons} ariaLabel="Library tools" />
        )}
      </div>

      {!isFilmstrip && selectedPhotoIds.size > 0 && (
        <div className="floating-selection-toolbar">
          <span className="floating-selection-toolbar-count">{selectedPhotoIds.size} selected</span>
          <div className="floating-selection-toolbar-actions">
            <button
              className="btn-ghost btn-sm"
              onClick={async () => {
                const selectedPhotos = photos.filter((p) => selectedPhotoIds.has(p.id));
                for (const photo of selectedPhotos) {
                  await toggleFavorite(photo.id);
                }
                setSelectedPhotoIds(new Set());
              }}
              title="Toggle favorite"
            >
              ♥
            </button>
            <select
              className="btn-ghost btn-sm"
              aria-label="Select album for bulk add"
              value={bulkAlbumId}
              onChange={(e) => setBulkAlbumId(e.target.value)}
              disabled={albums.length === 0}
            >
              <option value="">Add to album…</option>
              {albums.map((album) => (
                <option key={album.id} value={album.id}>
                  {album.name}
                </option>
              ))}
            </select>
            <button
              className="btn-ghost btn-sm"
              onClick={handleBulkAddToAlbum}
              title="Add selected photos to album"
              disabled={!bulkAlbumId || selectedPhotoIds.size === 0}
            >
              + Album
            </button>
            <input
              className="btn-ghost btn-sm"
              aria-label="Tag selected photos"
              placeholder="tag"
              value={bulkTagInput}
              onChange={(e) => setBulkTagInput(e.target.value)}
            />
            <button
              className="btn-ghost btn-sm"
              onClick={handleBulkTagApply}
              title="Apply tag to selected photos"
              disabled={!bulkTagInput.trim() || selectedPhotoIds.size === 0}
            >
              + Tag
            </button>
            <button
              className="btn-danger-ghost btn-sm"
              onClick={async () => {
                if (!confirm(`Delete ${selectedPhotoIds.size} selected photo(s)?`)) return;
                const selectedPhotos = photos.filter((p) => selectedPhotoIds.has(p.id));
                for (const photo of selectedPhotos) {
                  await deletePhoto(photo.id);
                }
                setSelectedPhotoIds(new Set());
              }}
              title="Delete selected"
            >
              ✕
            </button>
            <button
              className="btn-ghost btn-sm"
              onClick={() => setSelectedPhotoIds(new Set())}
              title="Clear selection"
            >
              Clear
            </button>
          </div>
          {bulkActionMessage && (
            <span className="state-message" role="status" aria-live="polite">
              {bulkActionMessage}
            </span>
          )}
        </div>
      )}

      {showUploadModal && (
        <UploadModal onClose={() => setShowUploadModal(false)} onUpload={handleUpload} />
      )}
    </>
  );
}
