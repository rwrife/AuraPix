import { ReactNode, useEffect, useRef, useState } from "react";
import type { Photo } from "../domain/library/types";
import { PhotoViewer } from "./PhotoViewer";

type GridMode = "small" | "medium" | "large";
type ViewMode = GridMode | "filmstrip";

interface PhotoGalleryProps {
  photos: Photo[];
  /** Overlay action buttons rendered on each tile (stop-propagation is handled internally) */
  renderOverlayActions?: (photo: Photo) => ReactNode;
  /** Called when filmstrip mode is entered or exited */
  onIsFilmstripChange?: (isFilmstrip: boolean) => void;
}

const GRID_BTNS: { mode: GridMode; icon: string; title: string }[] = [
  { mode: "small", icon: "⊟", title: "Small tiles (128×128)" },
  { mode: "medium", icon: "⊞", title: "Medium tiles (256×256)" },
  { mode: "large", icon: "▣", title: "Large tiles (320×320)" },
];

export function PhotoGallery({
  photos,
  renderOverlayActions,
  onIsFilmstripChange,
}: PhotoGalleryProps) {
  const [mode, setMode] = useState<ViewMode>("medium");
  const [viewerIndex, setViewerIndex] = useState(0);
  const prevGridMode = useRef<GridMode>("medium");

  const isFilmstrip = mode === "filmstrip";

  useEffect(() => {
    onIsFilmstripChange?.(isFilmstrip);
  }, [isFilmstrip, onIsFilmstripChange]);

  function enterFilmstrip(idx: number) {
    if (mode !== "filmstrip") prevGridMode.current = mode as GridMode;
    setViewerIndex(idx);
    setMode("filmstrip");
  }

  function exitFilmstrip() {
    setMode(prevGridMode.current);
  }

  function switchGrid(newMode: GridMode) {
    prevGridMode.current = newMode;
    setMode(newMode);
  }

  if (photos.length === 0) return null;

  // ── Filmstrip view ──────────────────────────────────────────────────────
  if (isFilmstrip) {
    return (
      <PhotoViewer
        photos={photos}
        initialIndex={viewerIndex}
        onClose={exitFilmstrip}
      />
    );
  }

  // ── Grid view ───────────────────────────────────────────────────────────
  return (
    <div className="photo-gallery">
      {/* View-mode toolbar */}
      <div className="photo-gallery-toolbar">
        {GRID_BTNS.map(({ mode: m, icon, title }) => (
          <button
            key={m}
            className={`btn-ghost btn-sm gallery-mode-btn${mode === m ? " active" : ""}`}
            title={title}
            onClick={() => switchGrid(m)}
          aria-pressed={mode === m ? "true" : "false"}
          >
            {icon}
          </button>
        ))}
        <button
          className="btn-ghost btn-sm gallery-mode-btn"
          title="Filmstrip view"
          onClick={() => enterFilmstrip(0)}
          aria-pressed="false"
        >
          ▶
        </button>
      </div>

      {/* Tiles */}
      <div className={`photo-grid-gallery photo-grid-gallery--${mode}`}>
        {photos.map((photo, idx) => (
          <div
            key={photo.id}
            className={`gallery-tile${mode === "large" ? " gallery-tile--large" : ""}`}
            onClick={() => enterFilmstrip(idx)}
            title={photo.originalName}
          >
            <img
              src={photo.thumbnailPath ?? photo.storagePath}
              alt={photo.originalName}
              className="gallery-tile-img"
              loading="lazy"
            />
            {mode === "large" && (
              <p className="gallery-tile-name">{photo.originalName}</p>
            )}
            {renderOverlayActions && (
              <div
                className="gallery-tile-overlay"
                onClick={(e) => e.stopPropagation()}
              >
                {renderOverlayActions(photo)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}