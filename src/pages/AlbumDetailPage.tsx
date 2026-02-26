import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PhotoGallery } from '../components/PhotoGallery';
import { GRID_BUTTONS, type GridMode } from '../components/photoGalleryConfig';
import type { ViewerState } from '../components/PhotoViewer';
import { UploadModal } from '../components/UploadModal';
import type { Photo } from '../domain/library/types';
import { useAlbums } from '../features/albums/useAlbums';
import { useAuth } from '../features/auth/useAuth';
import { useLibrary } from '../features/library/useLibrary';
import { useServices } from '../services/useServices';

function toLibraryId(userId: string) {
  return `library-${userId}`;
}

export function AlbumDetailPage() {
  const { albumId } = useParams<{ albumId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    albums,
    folders,
    loading: albumsLoading,
    error: albumsError,
    renameAlbum,
    moveAlbum,
    deleteAlbum,
  } = useAlbums();
  const { library } = useServices();
  const libraryId = toLibraryId(user?.id ?? 'local-user-1');

  const {
    photos: allPhotos,
    loading: libraryLoading,
    addPhoto,
    assignToAlbum,
    refresh,
    deletePhoto,
    toggleFavorite,
  } = useLibrary(libraryId);

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [isFilmstrip, setIsFilmstrip] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [folderInput, setFolderInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [gridMode, setGridMode] = useState<GridMode>('medium');
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
  const viewerStateRef = useRef<ViewerState | null>(null);
  const [viewerState, setViewerState] = useState<ViewerState | null>(null);

  const album = albums.find((a) => a.id === albumId) ?? null;

  const albumPhotos = allPhotos.filter((p) => albumId != null && p.albumIds.includes(albumId));

  useEffect(() => {
    if (!album) return;
    setNameInput(album.name);
    setFolderInput(album.folderId ?? '');
  }, [album]);

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

  async function handleUpload(
    files: File[],
    targetAlbumId: string | null,
    onProgress: (completed: number, total: number) => void
  ) {
    for (let i = 0; i < files.length; i++) {
      const photo = await addPhoto(files[i]);
      if (targetAlbumId) await assignToAlbum(photo.id, targetAlbumId, photo);
      onProgress(i + 1, files.length);
    }
  }

  const removeFromAlbum = useCallback(
    async (photo: Photo) => {
      if (!albumId) return;
      const newAlbumIds = photo.albumIds.filter((id) => id !== albumId);
      await library.updatePhoto(photo.id, { albumIds: newAlbumIds });
      refresh();
    },
    [library, albumId, refresh]
  );

  async function handleDeleteAlbum() {
    if (!albumId) return;
    if (!confirm(`Delete album "${album?.name}"? Photos will not be deleted.`)) return;
    await deleteAlbum(albumId);
    navigate('/albums');
  }

  async function handleSaveSettings() {
    if (!albumId || !album) return;
    const trimmedName = nameInput.trim();
    if (!trimmedName) return;

    setSaving(true);
    if (trimmedName !== album.name) {
      await renameAlbum(albumId, trimmedName);
    }

    const nextFolderId = folderInput === '' ? null : folderInput;
    const currentFolderId = album.folderId ?? null;
    if (nextFolderId !== currentFolderId) {
      await moveAlbum(albumId, nextFolderId);
    }
    setSaving(false);
  }

  const hasSettingsChanges =
    album != null &&
    (nameInput.trim() !== album.name ||
      (folderInput === '' ? null : folderInput) !== (album.folderId ?? null));

  if (albumsLoading) return <p className="state-message">Loading album…</p>;

  if (!album) {
    return (
      <div className="page">
        <p className="error">Album not found.</p>
        <Link to="/albums" className="nav-link">
          ← Back to albums
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="page-titlebar">
        <Link to="/albums" className="btn-ghost btn-sm">
          ← Albums
        </Link>
        <h1 className="page-title">{album.name}</h1>
        {!isFilmstrip && albumPhotos.length > 0 && (
          <div className="titlebar-controls">
            {selectedPhotoIds.size > 0 && (
              <button
                className="btn-ghost btn-sm"
                title="Select none"
                onClick={() => setSelectedPhotoIds(new Set())}
              >
                ☐
              </button>
            )}
            <button
              className="btn-ghost btn-sm"
              title="Select all"
              onClick={() => setSelectedPhotoIds(new Set(albumPhotos.map((p) => p.id)))}
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
          {libraryLoading ? (
            <p className="state-message">Loading photos…</p>
          ) : albumPhotos.length === 0 ? (
            <div className="empty-state">
              <p>No photos in this album yet.</p>
              <p>
                Use <strong>Add Photos</strong> from the right toolbar.
              </p>
            </div>
          ) : (
            <PhotoGallery
              photos={albumPhotos}
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
        </div>

        <aside className="page-right-column" aria-label="Album tools">
          {isFilmstrip ? (
            viewerState ? (
              <>
                <button
                  className="right-toolbar-icon btn-danger-ghost"
                  title="Delete"
                  onClick={() => viewerState.showDeleteConfirm()}
                >
                  🗑
                </button>
                <button
                  className="right-toolbar-icon btn-ghost"
                  title="Info"
                  onClick={() =>
                    viewerState.setActiveTool(viewerState.activeTool === 'info' ? null : 'info')
                  }
                >
                  ℹ
                </button>
                <button
                  className="right-toolbar-icon btn-ghost"
                  title="Versions"
                  onClick={() =>
                    viewerState.setActiveTool(
                      viewerState.activeTool === 'versions' ? null : 'versions'
                    )
                  }
                >
                  ⧉
                </button>
                <button
                  className={`right-toolbar-icon btn-ghost${viewerState.currentPhoto.isFavorite ? ' active' : ''}`}
                  title={viewerState.currentPhoto.isFavorite ? 'Unfavorite' : 'Favorite'}
                  onClick={() => viewerState.onToggleFavorite()}
                >
                  ♥
                </button>
                <button
                  className="right-toolbar-icon btn-ghost"
                  title="Comments"
                  onClick={() =>
                    viewerState.setActiveTool(
                      viewerState.activeTool === 'comments' ? null : 'comments'
                    )
                  }
                >
                  💬
                </button>
                <button
                  className="right-toolbar-icon btn-ghost"
                  title="Tags"
                  onClick={() =>
                    viewerState.setActiveTool(viewerState.activeTool === 'tags' ? null : 'tags')
                  }
                >
                  #
                </button>
                <button
                  className="right-toolbar-icon btn-ghost"
                  title="Presets"
                  onClick={() =>
                    viewerState.setActiveTool(
                      viewerState.activeTool === 'presets' ? null : 'presets'
                    )
                  }
                >
                  ✶
                </button>
                <button
                  className="right-toolbar-icon btn-ghost"
                  title="Edit"
                  onClick={() =>
                    viewerState.setActiveTool(viewerState.activeTool === 'edit' ? null : 'edit')
                  }
                >
                  🎚
                </button>
                <button
                  className="right-toolbar-icon btn-ghost"
                  title="Crop"
                  onClick={() =>
                    viewerState.setActiveTool(viewerState.activeTool === 'crop' ? null : 'crop')
                  }
                >
                  ⬚
                </button>

                {viewerState.activeTool && (
                  <section className="settings-panel">
                    {viewerState.activeTool === 'info' && (
                      <>
                        <h3 className="settings-panel-title">Info</h3>
                        <p className="state-message">
                          Name: {viewerState.currentPhoto.originalName}
                        </p>
                        <p className="state-message">ID: {viewerState.currentPhoto.id}</p>
                      </>
                    )}
                    {viewerState.activeTool === 'versions' && (
                      <>
                        <h3 className="settings-panel-title">Versions</h3>
                        <p className="state-message">Version history tools coming soon.</p>
                      </>
                    )}
                    {viewerState.activeTool === 'comments' && (
                      <>
                        <h3 className="settings-panel-title">Comments</h3>
                        <p className="state-message">Comments tools coming soon.</p>
                      </>
                    )}
                    {viewerState.activeTool === 'tags' && (
                      <>
                        <h3 className="settings-panel-title">Tags</h3>
                        <p className="state-message">Tag management tools coming soon.</p>
                      </>
                    )}
                    {viewerState.activeTool === 'presets' && (
                      <>
                        <h3 className="settings-panel-title">Presets</h3>
                        <p className="state-message">Preset tools coming soon.</p>
                      </>
                    )}
                    {viewerState.activeTool === 'edit' && (
                      <>
                        <h3 className="settings-panel-title">Edit</h3>
                        <label className="settings-label" htmlFor="edit-brightness">
                          Brightness
                        </label>
                        <input
                          id="edit-brightness"
                          type="range"
                          min={-100}
                          max={100}
                          value={viewerState.brightness}
                          onChange={(e) => viewerState.setBrightness(Number(e.target.value))}
                        />
                        <label className="settings-label" htmlFor="edit-contrast">
                          Contrast
                        </label>
                        <input
                          id="edit-contrast"
                          type="range"
                          min={-100}
                          max={100}
                          value={viewerState.contrast}
                          onChange={(e) => viewerState.setContrast(Number(e.target.value))}
                        />
                        <label className="settings-label" htmlFor="edit-saturation">
                          Saturation
                        </label>
                        <input
                          id="edit-saturation"
                          type="range"
                          min={-100}
                          max={100}
                          value={viewerState.saturation}
                          onChange={(e) => viewerState.setSaturation(Number(e.target.value))}
                        />
                      </>
                    )}
                    {viewerState.activeTool === 'crop' && (
                      <>
                        <h3 className="settings-panel-title">Crop</h3>
                        <p className="state-message">Crop tools coming soon.</p>
                      </>
                    )}
                  </section>
                )}
              </>
            ) : (
              <p className="state-message">Loading tools...</p>
            )
          ) : (
            <>
              <button
                className="btn-primary right-toolbar-icon"
                onClick={() => setShowUploadModal(true)}
                title="Add photos"
                aria-label="Add photos"
              >
                +
              </button>
              <button
                className="btn-ghost right-toolbar-icon"
                onClick={async () => {
                  if (selectedPhotoIds.size === 0) return;
                  const selectedPhotos = albumPhotos.filter((p) => selectedPhotoIds.has(p.id));
                  for (const photo of selectedPhotos) {
                    await toggleFavorite(photo.id);
                  }
                  setSelectedPhotoIds(new Set());
                }}
                disabled={selectedPhotoIds.size === 0}
                title="Toggle favorite"
                aria-label="Toggle favorite"
              >
                ♥
              </button>
              <button
                className="btn-danger-ghost right-toolbar-icon"
                onClick={async () => {
                  if (selectedPhotoIds.size === 0) return;
                  if (!confirm(`Delete ${selectedPhotoIds.size} photo(s)?`)) return;
                  const selectedPhotos = albumPhotos.filter((p) => selectedPhotoIds.has(p.id));
                  for (const photo of selectedPhotos) {
                    await deletePhoto(photo.id);
                  }
                  setSelectedPhotoIds(new Set());
                }}
                disabled={selectedPhotoIds.size === 0}
                title="Delete photos"
                aria-label="Delete photos"
              >
                ✕
              </button>
              <button
                className={`btn-ghost right-toolbar-icon${showSettings ? ' active' : ''}`}
                onClick={() => setShowSettings((v) => !v)}
                title="Album settings"
                aria-label="Album settings"
              >
                ⚙
              </button>

              {showSettings && (
                <div className="settings-panel">
                  <h2 className="settings-panel-title">Album Settings</h2>
                  <label className="settings-label" htmlFor="album-name-input">
                    Name
                  </label>
                  <input
                    id="album-name-input"
                    type="text"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                  />

                  <label className="settings-label" htmlFor="album-folder-select">
                    Folder
                  </label>
                  <select
                    id="album-folder-select"
                    className="settings-select"
                    value={folderInput}
                    onChange={(e) => setFolderInput(e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {folders.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}
                      </option>
                    ))}
                  </select>

                  <button
                    className="btn-primary"
                    disabled={saving || !nameInput.trim() || !hasSettingsChanges}
                    onClick={handleSaveSettings}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>

                  <button className="btn-danger-ghost" onClick={handleDeleteAlbum}>
                    Delete Album
                  </button>

                  {albumsError && <p className="error">{albumsError}</p>}
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      {!isFilmstrip && selectedPhotoIds.size > 0 && (
        <div className="floating-selection-toolbar">
          <span className="floating-selection-toolbar-count">{selectedPhotoIds.size} selected</span>
          <div className="floating-selection-toolbar-actions">
            <button
              className="btn-ghost btn-sm"
              onClick={async () => {
                const selectedPhotos = albumPhotos.filter((p) => selectedPhotoIds.has(p.id));
                for (const photo of selectedPhotos) {
                  await toggleFavorite(photo.id);
                }
                setSelectedPhotoIds(new Set());
              }}
              title="Toggle favorite"
            >
              ♥
            </button>
            <button
              className="btn-ghost btn-sm"
              onClick={async () => {
                if (!confirm(`Remove ${selectedPhotoIds.size} photo(s) from album?`)) return;
                const selectedPhotos = albumPhotos.filter((p) => selectedPhotoIds.has(p.id));
                for (const photo of selectedPhotos) {
                  await removeFromAlbum(photo);
                }
                setSelectedPhotoIds(new Set());
              }}
              title="Remove from album"
            >
              −
            </button>
            <button
              className="btn-danger-ghost btn-sm"
              onClick={async () => {
                if (!confirm(`Delete ${selectedPhotoIds.size} photo(s)?`)) return;
                const selectedPhotos = albumPhotos.filter((p) => selectedPhotoIds.has(p.id));
                for (const photo of selectedPhotos) {
                  await deletePhoto(photo.id);
                }
                setSelectedPhotoIds(new Set());
              }}
              title="Delete photos"
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
        </div>
      )}

      {showUploadModal && albumId && (
        <UploadModal
          preselectedAlbumId={albumId}
          onClose={() => setShowUploadModal(false)}
          onUpload={handleUpload}
        />
      )}
    </>
  );
}
