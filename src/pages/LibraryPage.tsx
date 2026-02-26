import { useEffect, useRef, useState, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PhotoGallery } from "../components/PhotoGallery";
import { GRID_BUTTONS, type GridMode } from "../components/photoGalleryConfig";
import type { ViewerState } from "../components/PhotoViewer";
import { UploadModal } from "../components/UploadModal";
import { Toolbar } from "../components/toolbar";
import { ViewerToolbar } from "../components/toolbar";
import { createViewerToolbarConfig } from "../components/toolbar/examples/viewerToolbarConfig";
import type { ToolbarButton, ModalContentProps } from "../components/toolbar";
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

  // Gallery toolbar configuration
  const galleryToolbarButtons = useMemo<ToolbarButton[]>(() => {
    return [
      {
        type: "toggle",
        id: "favorite",
        icon: "♥",
        title: "Toggle favorite",
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
        type: "modal",
        id: "delete",
        icon: "✕",
        title: "Delete selected",
        className: "btn-danger-ghost",
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
