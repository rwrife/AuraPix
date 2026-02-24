import { useRef, useState } from "react";
import { PhotoViewer } from "../components/PhotoViewer";
import { useAuth } from "../features/auth/useAuth";
import { useLibrary } from "../features/library/useLibrary";

function toLibraryId(userId: string) {
  return `library-${userId}`;
}

export function LibraryPage() {
  const { user } = useAuth();
  const libraryId = toLibraryId(user?.id ?? "local-user-1");
  const { photos, loading, error, addPhoto, toggleFavorite, deletePhoto } =
    useLibrary(libraryId);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      await addPhoto(file);
    }
  }

  const isViewing = viewerIndex !== null && photos.length > 0;

  return (
    <div className={`page${isViewing ? " page--viewer-mode" : ""}`}>
      <div className="page-header">
        <h1 className="page-title">Library</h1>
        {isViewing ? (
          <button className="btn-ghost" onClick={() => setViewerIndex(null)}>
            ← Back to grid
          </button>
        ) : (
          <button
            className="btn-primary"
            onClick={() => fileInputRef.current?.click()}
          >
            + Upload photos
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {error && <p className="error">{error}</p>}

      {isViewing ? (
        <PhotoViewer
          photos={photos}
          initialIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      ) : loading ? (
        <p className="state-message">Loading library…</p>
      ) : photos.length === 0 ? (
        <div className="empty-state">
          <p>No photos yet.</p>
          <p>
            Click <strong>Upload photos</strong> to add images.
          </p>
        </div>
      ) : (
        <div className="photo-grid">
          {photos.map((photo, idx) => (
            <div key={photo.id} className="photo-card">
              <button
                className="photo-thumb-btn"
                onClick={() => setViewerIndex(idx)}
                title="View photo"
              >
                <img
                  src={photo.thumbnailPath ?? photo.storagePath}
                  alt={photo.originalName}
                  className="photo-thumb"
                  loading="lazy"
                />
              </button>
              <div className="photo-actions">
                <button
                  className={`btn-icon ${photo.isFavorite ? "active" : ""}`}
                  title={
                    photo.isFavorite
                      ? "Remove from favorites"
                      : "Add to favorites"
                  }
                  onClick={() => toggleFavorite(photo.id)}
                >
                  {photo.isFavorite ? "♥" : "♡"}
                </button>
                <button
                  className="btn-icon btn-danger"
                  title="Delete photo"
                  onClick={() => deletePhoto(photo.id)}
                >
                  ✕
                </button>
              </div>
              <p className="photo-name" title={photo.originalName}>
                {photo.originalName}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}