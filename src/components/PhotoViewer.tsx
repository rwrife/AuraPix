import { useCallback, useEffect, useRef, useState } from "react";
import type { Photo } from "../domain/library/types";

interface PhotoViewerProps {
  photos: Photo[];
  initialIndex: number;
  onClose(): void;
}

export function PhotoViewer({ photos, initialIndex, onClose }: PhotoViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(
    Math.max(0, Math.min(initialIndex, photos.length - 1)),
  );
  const filmstripRef = useRef<HTMLDivElement>(null);
  const current = photos[currentIndex];

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

  if (!current) return null;

  return (
    <div className="photo-viewer-panel">
      {/* Back / close button */}
      <button className="photo-viewer-close" onClick={onClose} title="Back to grid (Esc)">
        ✕
      </button>

      {/* Main image area */}
      <div className="photo-viewer-main">
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

      {/* Caption */}
      <p className="photo-viewer-caption">
        <span className="photo-viewer-name">{current.originalName}</span>
        <span className="photo-viewer-counter">
          {currentIndex + 1} / {photos.length}
        </span>
      </p>

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
  );
}