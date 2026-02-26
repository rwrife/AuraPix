import { useCallback, useEffect, useRef, useState } from "react";
import type { Photo } from "../domain/library/types";

interface PhotoViewerProps {
  photos: Photo[];
  initialIndex: number;
  onClose(): void;
  onDeletePhoto?: (photo: Photo) => Promise<void> | void;
  onToggleFavorite?: (photo: Photo) => Promise<void> | void;
  viewerStateRef?: React.MutableRefObject<ViewerState | null>;
}

export interface ViewerState {
  currentPhoto: Photo;
  currentIndex: number;
  totalPhotos: number;
  activeTool: ViewerTool | null;
  setActiveTool: (tool: ViewerTool | null) => void;
  showDeleteConfirm: () => void;
  brightness: number;
  setBrightness: (v: number) => void;
  contrast: number;
  setContrast: (v: number) => void;
  saturation: number;
  setSaturation: (v: number) => void;
  onToggleFavorite: () => void;
}

type ViewerTool =
  | "info"
  | "versions"
  | "comments"
  | "tags"
  | "presets"
  | "edit"
  | "crop";

export function PhotoViewer({
  photos,
  initialIndex,
  onClose,
  onDeletePhoto,
  onToggleFavorite,
  viewerStateRef,
}: PhotoViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(
    Math.max(0, Math.min(initialIndex, photos.length - 1)),
  );
  const [activeTool, setActiveTool] = useState<ViewerTool | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [saturation, setSaturation] = useState(0);
  const filmstripRef = useRef<HTMLDivElement>(null);
  const current = photos[currentIndex];

  // Expose viewer state to parent via ref
  useEffect(() => {
    if (viewerStateRef) {
      viewerStateRef.current = {
        currentPhoto: current,
        currentIndex,
        totalPhotos: photos.length,
        activeTool,
        setActiveTool,
        showDeleteConfirm: () => setShowDeleteConfirm(true),
        brightness,
        setBrightness,
        contrast,
        setContrast,
        saturation,
        setSaturation,
        onToggleFavorite: () => onToggleFavorite?.(current),
      };
    }
  }, [viewerStateRef, current, currentIndex, photos.length, activeTool, brightness, contrast, saturation, onToggleFavorite]);

  const goPrev = useCallback(
    () => setCurrentIndex((i) => Math.max(0, i - 1)),
    [],
  );
  const goNext = useCallback(
    () => setCurrentIndex((i) => Math.min(photos.length - 1, i + 1)),
    [photos.length],
  );

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
      else if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [goPrev, goNext, onClose]);

  // Scroll filmstrip to keep active thumbnail visible
  useEffect(() => {
    const strip = filmstripRef.current;
    if (!strip) return;
    const thumb = strip.children[currentIndex] as HTMLElement | undefined;
    if (thumb) {
      thumb.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" });
    }
  }, [currentIndex]);

  useEffect(() => {
    setCurrentIndex((idx) => {
      if (photos.length === 0) return 0;
      return Math.max(0, Math.min(idx, photos.length - 1));
    });
  }, [photos.length]);

  async function confirmDeletePhoto() {
    if (!current || !onDeletePhoto || deleting) return;
    setDeleting(true);
    await onDeletePhoto(current);
    setDeleting(false);
    setShowDeleteConfirm(false);
    if (photos.length <= 1) onClose();
  }

  if (!current) return null;

  return (
    <>
      <div className="photo-viewer-fullscreen">
        {/* Main image area */}
        <div className="photo-viewer-image-container">
          <button
            className="photo-viewer-nav photo-viewer-nav-prev"
            onClick={goPrev}
            disabled={currentIndex === 0}
            title="Previous (←)"
          >
            ‹
          </button>

          <div className="photo-viewer-image-wrap">
            <img
              key={current.id}
              src={current.storagePath}
              alt={current.originalName}
              className="photo-viewer-image"
            />
          </div>

          <button
            className="photo-viewer-nav photo-viewer-nav-next"
            onClick={goNext}
            disabled={currentIndex === photos.length - 1}
            title="Next (→)"
          >
            ›
          </button>
        </div>

        {/* Filmstrip */}
        <div className="photo-viewer-filmstrip" ref={filmstripRef}>
          {photos.map((photo, idx) => (
            <button
              key={photo.id}
              className={`filmstrip-thumb${idx === currentIndex ? " active" : ""}`}
              onClick={() => setCurrentIndex(idx)}
              title={photo.originalName}
            >
              <img
                src={photo.thumbnailPath ?? photo.storagePath}
                alt={photo.originalName}
                loading="lazy"
              />
            </button>
          ))}
        </div>
      </div>


      {showDeleteConfirm && (
        <div className="confirm-modal-backdrop" role="presentation">
          <div className="confirm-modal" role="dialog" aria-modal="true">
            <h3 className="settings-panel-title">Delete photo?</h3>
            <p className="state-message">
              This will permanently delete this photo.
            </p>
            <div className="confirm-modal-actions">
              <button className="btn-ghost" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn-danger-ghost"
                onClick={confirmDeletePhoto}
                disabled={deleting}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
