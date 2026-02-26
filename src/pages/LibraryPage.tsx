import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PhotoGallery } from "../components/PhotoGallery";
import { GRID_BUTTONS, type GridMode } from "../components/photoGalleryConfig";
import type { ViewerState } from "../components/PhotoViewer";
import { UploadModal } from "../components/UploadModal";
import { useAuth } from "../features/auth/useAuth";
import { useLibrary } from "../features/library/useLibrary";

function toLibraryId(userId: string) {
  return `library-${userId}`;
}

export function LibraryPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const libraryId = toLibraryId(user?.id ?? "local-user-1");
  const { photos, loading, error, addPhoto, assignToAlbum, toggleFavorite, deletePhoto } =
    useLibrary(libraryId);

  const [isFilmstrip, setIsFilmstrip] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [gridMode, setGridMode] = useState<GridMode>("medium");
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
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
    if (params.get("upload") !== "1") return;

    setShowUploadModal(true);
    params.delete("upload");
    const search = params.toString();
    navigate(
      {
        pathname: "/library",
        search: search ? `?${search}` : "",
      },
      { replace: true },
    );
  }, [location.search, navigate]);

  async function handleUpload(
    files: File[],
    albumId: string | null,
    onProgress: (completed: number, total: number) => void,
  ) {
    for (let i = 0; i < files.length; i++) {
      const photo = await addPhoto(files[i]);
      if (albumId) await assignToAlbum(photo.id, albumId, photo);
      onProgress(i + 1, files.length);
    }
  }

  return (
    <>
      <div className="page-titlebar">
        <h1 className="page-title">Library</h1>
        {!isFilmstrip && photos.length > 0 && (
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
              onClick={() => setSelectedPhotoIds(new Set(photos.map((p) => p.id)))}
            >
              ☑
            </button>
            {GRID_BUTTONS.map(({ mode, icon, title }) => (
              <button
                key={mode}
                className={`btn-ghost btn-sm${gridMode === mode ? " active" : ""}`}
                title={title}
                onClick={() => setGridMode(mode)}
              >
                {icon}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={`page-with-toolbar${isFilmstrip ? " page--viewer-mode" : ""}`}>
        <div className="page-center-column">
          {error && <p className="error">{error}</p>}

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
        </div>
        {/* Slide-out panel for viewer tools */}
        {isFilmstrip && (
          <div className={`viewer-slide-panel${viewerState?.activeTool ? " open" : ""}`}>
            <div className="viewer-slide-panel-header">
              <h3 className="viewer-slide-panel-title">
                {viewerState?.activeTool === "info" && "Info"}
                {viewerState?.activeTool === "versions" && "Versions"}
                {viewerState?.activeTool === "comments" && "Comments"}
                {viewerState?.activeTool === "tags" && "Tags"}
                {viewerState?.activeTool === "presets" && "Presets"}
                {viewerState?.activeTool === "edit" && "Edit"}
                {viewerState?.activeTool === "crop" && "Crop"}
              </h3>
              <button
                className="viewer-slide-panel-close"
                onClick={() => viewerState?.setActiveTool(null)}
                title="Close (Esc)"
              >
                ✕
              </button>
            </div>
            <div className="viewer-slide-panel-body">
              {viewerState?.activeTool === "info" && (
                <>
                  <p className="state-message">Name: {viewerState?.currentPhoto.originalName}</p>
                  <p className="state-message">ID: {viewerState?.currentPhoto.id}</p>
                </>
              )}
              {viewerState?.activeTool === "versions" && (
                <p className="state-message">Version history tools coming soon.</p>
              )}
              {viewerState?.activeTool === "comments" && (
                <p className="state-message">Comments tools coming soon.</p>
              )}
              {viewerState?.activeTool === "tags" && (
                <p className="state-message">Tag management tools coming soon.</p>
              )}
              {viewerState?.activeTool === "presets" && (
                <p className="state-message">Preset tools coming soon.</p>
              )}
              {viewerState?.activeTool === "edit" && (
                <>
                  <label className="settings-label" htmlFor="edit-brightness">
                    Brightness
                  </label>
                  <input
                    id="edit-brightness"
                    type="range"
                    min={-100}
                    max={100}
                    value={viewerState?.brightness ?? 0}
                    onChange={(e) => viewerState?.setBrightness(Number(e.target.value))}
                  />
                  <label className="settings-label" htmlFor="edit-contrast">
                    Contrast
                  </label>
                  <input
                    id="edit-contrast"
                    type="range"
                    min={-100}
                    max={100}
                    value={viewerState?.contrast ?? 0}
                    onChange={(e) => viewerState?.setContrast(Number(e.target.value))}
                  />
                  <label className="settings-label" htmlFor="edit-saturation">
                    Saturation
                  </label>
                  <input
                    id="edit-saturation"
                    type="range"
                    min={-100}
                    max={100}
                    value={viewerState?.saturation ?? 0}
                    onChange={(e) => viewerState?.setSaturation(Number(e.target.value))}
                  />
                </>
              )}
              {viewerState?.activeTool === "crop" && (
                <p className="state-message">Crop tools coming soon.</p>
              )}
            </div>
          </div>
        )}

        <aside className="page-right-column" aria-label="Library tools">
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
                onClick={() => viewerState.setActiveTool(viewerState.activeTool === "info" ? null : "info")}
              >
                ℹ
              </button>
              <button
                className="right-toolbar-icon btn-ghost"
                title="Versions"
                onClick={() => viewerState.setActiveTool(viewerState.activeTool === "versions" ? null : "versions")}
              >
                ⧉
              </button>
              <button
                className={`right-toolbar-icon btn-ghost${viewerState.currentPhoto.isFavorite ? " active" : ""}`}
                title={viewerState.currentPhoto.isFavorite ? "Unfavorite" : "Favorite"}
                onClick={() => viewerState.onToggleFavorite()}
              >
                ♥
              </button>
              <button
                className="right-toolbar-icon btn-ghost"
                title="Comments"
                onClick={() => viewerState.setActiveTool(viewerState.activeTool === "comments" ? null : "comments")}
              >
                💬
              </button>
              <button
                className="right-toolbar-icon btn-ghost"
                title="Tags"
                onClick={() => viewerState.setActiveTool(viewerState.activeTool === "tags" ? null : "tags")}
              >
                #
              </button>
              <button
                className="right-toolbar-icon btn-ghost"
                title="Presets"
                onClick={() => viewerState.setActiveTool(viewerState.activeTool === "presets" ? null : "presets")}
              >
                ✶
              </button>
              <button
                className="right-toolbar-icon btn-ghost"
                title="Edit"
                onClick={() => viewerState.setActiveTool(viewerState.activeTool === "edit" ? null : "edit")}
              >
                🎚
              </button>
              <button
                className="right-toolbar-icon btn-ghost"
                title="Crop"
                onClick={() => viewerState.setActiveTool(viewerState.activeTool === "crop" ? null : "crop")}
              >
                ⬚
              </button>

              {viewerState.activeTool && (
                <section className="settings-panel">
                  {viewerState.activeTool === "info" && (
                    <>
                      <h3 className="settings-panel-title">Info</h3>
                      <p className="state-message">Name: {viewerState.currentPhoto.originalName}</p>
                      <p className="state-message">ID: {viewerState.currentPhoto.id}</p>
                    </>
                  )}
                  {viewerState.activeTool === "versions" && (
                    <>
                      <h3 className="settings-panel-title">Versions</h3>
                      <p className="state-message">Version history tools coming soon.</p>
                    </>
                  )}
                  {viewerState.activeTool === "comments" && (
                    <>
                      <h3 className="settings-panel-title">Comments</h3>
                      <p className="state-message">Comments tools coming soon.</p>
                    </>
                  )}
                  {viewerState.activeTool === "tags" && (
                    <>
                      <h3 className="settings-panel-title">Tags</h3>
                      <p className="state-message">Tag management tools coming soon.</p>
                    </>
                  )}
                  {viewerState.activeTool === "presets" && (
                    <>
                      <h3 className="settings-panel-title">Presets</h3>
                      <p className="state-message">Preset tools coming soon.</p>
                    </>
                  )}
                  {viewerState.activeTool === "edit" && (
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
                  {viewerState.activeTool === "crop" && (
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
                className="btn-ghost right-toolbar-icon"
                onClick={async () => {
                  if (selectedPhotoIds.size === 0) return;
                  const selectedPhotos = photos.filter((p) => selectedPhotoIds.has(p.id));
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
                  if (!confirm(`Delete ${selectedPhotoIds.size} selected photo(s)?`)) return;
                  const selectedPhotos = photos.filter((p) => selectedPhotoIds.has(p.id));
                  for (const photo of selectedPhotos) {
                    await deletePhoto(photo.id);
                  }
                  setSelectedPhotoIds(new Set());
                }}
                disabled={selectedPhotoIds.size === 0}
                title="Delete selected"
                aria-label="Delete selected"
              >
                ✕
              </button>
            </>
          )}
        </aside>
      </div>

      {!isFilmstrip && selectedPhotoIds.size > 0 && (
        <div className="floating-selection-toolbar">
          <span className="floating-selection-toolbar-count">
            {selectedPhotoIds.size} selected
          </span>
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
        </div>
      )}

      {showUploadModal && (
        <UploadModal
          onClose={() => setShowUploadModal(false)}
          onUpload={handleUpload}
        />
      )}
    </>
  );
}
