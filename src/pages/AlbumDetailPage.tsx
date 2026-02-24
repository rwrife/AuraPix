import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PhotoGallery } from "../components/PhotoGallery";
import type { Album } from "../domain/albums/types";
import type { Photo } from "../domain/library/types";
import { useAuth } from "../features/auth/useAuth";
import { useLibrary } from "../features/library/useLibrary";
import { useServices } from "../services/useServices";

function toLibraryId(userId: string) {
  return `library-${userId}`;
}

export function AlbumDetailPage() {
  const { albumId } = useParams<{ albumId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { albums, library } = useServices();
  const libraryId = toLibraryId(user?.id ?? "local-user-1");

  const { photos: allPhotos, loading: libraryLoading, addPhoto, assignToAlbum, refresh } =
    useLibrary(libraryId);

  const [album, setAlbum] = useState<Album | null>(null);
  const [albumLoading, setAlbumLoading] = useState(true);
  const [showPicker, setShowPicker] = useState(false);
  const [isFilmstrip, setIsFilmstrip] = useState(false);

  const pendingUpload = useRef(false);
  const prevPhotosLen = useRef(allPhotos.length);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const albumPhotos = allPhotos.filter(
    (p) => albumId != null && p.albumIds.includes(albumId),
  );
  const availablePhotos = allPhotos.filter(
    (p) => albumId != null && !p.albumIds.includes(albumId),
  );

  useEffect(() => {
    if (!albumId) return;
    setAlbumLoading(true);
    albums
      .getAlbum(albumId)
      .then((a) => { setAlbum(a); setAlbumLoading(false); })
      .catch(() => setAlbumLoading(false));
  }, [albums, albumId]);

  useEffect(() => {
    if (!albumId || !pendingUpload.current) {
      prevPhotosLen.current = allPhotos.length;
      return;
    }
    const addedCount = allPhotos.length - prevPhotosLen.current;
    if (addedCount > 0) {
      const newPhotos = allPhotos
        .filter((p) => !p.albumIds.includes(albumId))
        .slice(0, addedCount);
      newPhotos.forEach((p) => void assignToAlbum(p.id, albumId));
      pendingUpload.current = false;
    }
    prevPhotosLen.current = allPhotos.length;
  }, [allPhotos, albumId, assignToAlbum]);

  async function handleUploadToAlbum(files: FileList | null) {
    if (!files || !albumId) return;
    pendingUpload.current = true;
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) await addPhoto(file);
    }
  }

  const removeFromAlbum = useCallback(
    async (photo: Photo) => {
      if (!albumId) return;
      const newAlbumIds = photo.albumIds.filter((id) => id !== albumId);
      await library.updatePhoto(photo.id, { albumIds: newAlbumIds });
      refresh();
    },
    [library, albumId, refresh],
  );

  async function handleDeleteAlbum() {
    if (!albumId) return;
    if (!confirm(`Delete album "${album?.name}"? Photos will not be deleted.`))
      return;
    await albums.deleteAlbum(albumId);
    navigate("/albums");
  }

  if (albumLoading) return <p className="state-message">Loading album…</p>;

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
    <div className={`page${isFilmstrip ? " page--viewer-mode" : ""}`}>
      <div className="page-header">
        <Link to="/albums" className="btn-ghost btn-sm">
          ← Albums
        </Link>
        <h1 className="page-title">{album.name}</h1>
        {!isFilmstrip && (
          <div className="header-actions">
            <button
              className="btn-primary"
              onClick={() => {
                pendingUpload.current = true;
                fileInputRef.current?.click();
              }}
            >
              + Upload to album
            </button>
            <button
              className="btn-ghost"
              onClick={() => setShowPicker((v) => !v)}
              disabled={availablePhotos.length === 0}
            >
              Add from library
              {availablePhotos.length > 0 ? ` (${availablePhotos.length})` : ""}
            </button>
            <button className="btn-danger-ghost" onClick={handleDeleteAlbum}>
              Delete album
            </button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => handleUploadToAlbum(e.target.files)}
        />
      </div>

      {!isFilmstrip && showPicker && availablePhotos.length > 0 && (
        <div className="photo-picker">
          <p className="picker-label">
            Select photos from your library to add to this album:
          </p>
          <div className="photo-grid">
            {availablePhotos.map((photo) => (
              <PhotoPickerCard
                key={photo.id}
                photo={photo}
                onAdd={async () => {
                  if (albumId) await assignToAlbum(photo.id, albumId);
                }}
              />
            ))}
          </div>
        </div>
      )}

      {libraryLoading ? (
        <p className="state-message">Loading photos…</p>
      ) : albumPhotos.length === 0 ? (
        <div className="empty-state">
          <p>No photos in this album yet.</p>
          <p>
            Click <strong>Upload to album</strong> or{" "}
            <strong>Add from library</strong> above.
          </p>
        </div>
      ) : (
        <PhotoGallery
          photos={albumPhotos}
          onIsFilmstripChange={setIsFilmstrip}
          renderOverlayActions={(photo) => (
            <button
              className="btn-icon btn-danger"
              title="Remove from album"
              onClick={() => removeFromAlbum(photo)}
            >
              ✕
            </button>
          )}
        />
      )}
    </div>
  );
}

function PhotoPickerCard({
  photo,
  onAdd,
}: {
  photo: Photo;
  onAdd: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="photo-card picker-card">
      <img
        src={photo.thumbnailPath ?? photo.storagePath}
        alt={photo.originalName}
        className="photo-thumb"
        loading="lazy"
      />
      <div className="photo-actions">
        <button
          className="btn-icon btn-add"
          disabled={adding}
          title="Add to album"
          onClick={async () => {
            setAdding(true);
            await onAdd();
            setAdding(false);
          }}
        >
          +
        </button>
      </div>
      <p className="photo-name" title={photo.originalName}>
        {photo.originalName}
      </p>
    </div>
  );
}