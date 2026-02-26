import { useEffect, useRef, useState } from "react";
import type { Photo } from "../domain/library/types";
import { PhotoViewer, type ViewerState } from "./PhotoViewer";

export type GridMode = "small" | "medium" | "large";
type ViewMode = GridMode | "filmstrip";

interface PhotoGalleryProps {
  photos: Photo[];
  /** Current grid mode */
  gridMode?: GridMode;
  /** Called when grid mode changes */
  onGridModeChange?: (mode: GridMode) => void;
  /** Selected photo IDs */
  selectedPhotoIds?: Set<string>;
  /** Called when selection changes */
  onSelectionChange?: (selectedIds: Set<string>) => void;
  /** Called when filmstrip mode is entered or exited */
  onIsFilmstripChange?: (isFilmstrip: boolean) => void;
  onDeletePhoto?: (photo: Photo) => Promise<void> | void;
  onToggleFavorite?: (photo: Photo) => Promise<void> | void;
  /** Ref to access viewer state for rendering tools in parent */
  viewerStateRef?: React.MutableRefObject<ViewerState | null>;
}

export const GRID_BUTTONS: { mode: GridMode; icon: string; title: string }[] = [
  { mode: "small", icon: "⊟", title: "Small tiles (128×128)" },
  { mode: "medium", icon: "⊞", title: "Medium tiles (256×256)" },
  { mode: "large", icon: "▣", title: "Large tiles (320×320)" },
];

export function PhotoGallery({
  photos,
  gridMode = "medium",
  selectedPhotoIds = new Set(),
  onSelectionChange,
  onIsFilmstripChange,
  onDeletePhoto,
  onToggleFavorite,
  viewerStateRef,
}: PhotoGalleryProps) {
  const [mode, setMode] = useState<ViewMode>(gridMode);
  const [viewerIndex, setViewerIndex] = useState(0);
  const prevGridMode = useRef<GridMode>(gridMode);

  const isFilmstrip = mode === "filmstrip";

  // Sync external gridMode changes
  useEffect(() => {
    if (mode !== "filmstrip") {
      setMode(gridMode);
      prevGridMode.current = gridMode;
    }
  }, [gridMode, mode]);

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

  function togglePhotoSelection(photoId: string, event: React.MouseEvent) {
    event.stopPropagation();
    const newSelection = new Set(selectedPhotoIds);
    if (newSelection.has(photoId)) {
      newSelection.delete(photoId);
    } else {
      newSelection.add(photoId);
    }
    onSelectionChange?.(newSelection);
  }

  function handleTileClick(idx: number, event: React.MouseEvent) {
    // If shift/ctrl/cmd key is held, toggle selection instead of opening viewer
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      togglePhotoSelection(photos[idx].id, event);
    } else {
      enterFilmstrip(idx);
    }
  }

  if (photos.length === 0) return null;

  // ── Filmstrip view ──────────────────────────────────────────────────────
  if (isFilmstrip) {
    return (
      <PhotoViewer
        photos={photos}
        initialIndex={viewerIndex}
        onClose={exitFilmstrip}
        onDeletePhoto={onDeletePhoto}
        onToggleFavorite={onToggleFavorite}
        viewerStateRef={viewerStateRef}
      />
    );
  }

  // ── Grid view ───────────────────────────────────────────────────────────
  return (
    <div className="photo-gallery">
      {/* Tiles */}
      <div className={`photo-grid-gallery photo-grid-gallery--${mode}`}>
        {photos.map((photo, idx) => {
          const isSelected = selectedPhotoIds.has(photo.id);
          return (
            <div
              key={photo.id}
              className={`gallery-tile${mode === "large" ? " gallery-tile--large" : ""}${isSelected ? " gallery-tile--selected" : ""}`}
              onClick={(e) => handleTileClick(idx, e)}
              title={photo.originalName}
            >
              {/* Selection checkbox */}
              <div className="gallery-tile-checkbox-wrapper">
                <input
                  type="checkbox"
                  className="gallery-tile-checkbox"
                  checked={isSelected}
                  onChange={(e) => {
                    e.stopPropagation();
                    const mouseEvent = e as unknown as React.MouseEvent;
                    togglePhotoSelection(photo.id, mouseEvent);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Select ${photo.originalName}`}
                />
              </div>

              <img
                src={photo.thumbnailPath ?? photo.storagePath}
                alt={photo.originalName}
                className="gallery-tile-img"
                loading="lazy"
              />
              {mode === "large" && (
                <p className="gallery-tile-name">{photo.originalName}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
