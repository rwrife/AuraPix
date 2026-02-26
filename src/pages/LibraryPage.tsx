import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PhotoGallery, GRID_BUTTONS, type GridMode } from "../components/PhotoGallery";
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
            />
          )}
        </div>
        <aside className="page-right-column" aria-label="Library tools">
          {!isFilmstrip && (
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
