import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
} from 'react';
import type { Photo } from '../domain/library/types';
import { PhotoViewer, type ViewerState } from './PhotoViewer';
import type { GridMode } from './photoGalleryConfig';
import { getBlurPlaceholderUrl, getThumbnailUrl } from '../utils/imageUrls';

type ViewMode = GridMode | 'filmstrip';

interface LazyImageProps {
  photo: Photo;
  className?: string;
  alt: string;
}

/**
 * Lazy-loaded image component with blur-up technique
 * Loads a small blurred placeholder first, then loads the full thumbnail when visible
 * Falls back to legacy storagePath/thumbnailPath for in-memory photos
 */
function LazyImage({ photo, className, alt }: LazyImageProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // Determine if this is a Firebase Storage URL, legacy in-memory photo, or API-based photo
  const isFirebaseStorageUrl = photo.storagePath?.startsWith('https://firebasestorage.googleapis.com');
  const isLegacyPhoto = photo.storagePath?.startsWith('data:') || photo.storagePath?.startsWith('blob:');

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.disconnect();
          }
        });
      },
      {
        rootMargin: '50px', // Load images slightly before they come into view
      }
    );

    observer.observe(img);

    return () => {
      observer.disconnect();
    };
  }, []);

  // Use Firebase Storage URLs directly if available, otherwise fall back to API or legacy URLs
  const blurUrl = isFirebaseStorageUrl || isLegacyPhoto
    ? (photo.thumbnailPath ?? photo.storagePath)
    : getBlurPlaceholderUrl(photo.libraryId, photo.id);
  const thumbnailUrl = isFirebaseStorageUrl || isLegacyPhoto
    ? (photo.thumbnailPath ?? photo.storagePath)
    : getThumbnailUrl(photo.libraryId, photo.id);

  return (
    <>
      {/* Blur placeholder - always loads immediately */}
      <img
        ref={imgRef}
        src={blurUrl}
        alt={alt}
        className={`${className} gallery-tile-img-blur`}
        style={{
          filter: isLoaded ? 'blur(0)' : isLegacyPhoto ? 'none' : 'blur(20px)',
          opacity: isLoaded ? 0 : 1,
          transition: 'opacity 0.3s ease-in-out',
        }}
      />
      {/* Full resolution thumbnail - loads when visible */}
      {isVisible && (
        <img
          src={thumbnailUrl}
          alt={alt}
          className={className}
          style={{
            opacity: isLoaded ? 1 : 0,
            transition: 'opacity 0.3s ease-in-out',
          }}
          onLoad={() => setIsLoaded(true)}
        />
      )}
    </>
  );
}

interface PhotoGalleryProps {
  photos: Photo[];
  gridMode?: GridMode;
  selectedPhotoIds?: Set<string>;
  onSelectionChange?: (selectedIds: Set<string>) => void;
  onGridModeChange?: (mode: GridMode) => void;
  onIsFilmstripChange?: (isFilmstrip: boolean) => void;
  onDeletePhoto?: (photo: Photo) => Promise<void> | void;
  onToggleFavorite?: (photo: Photo) => Promise<void> | void;
  viewerStateRef?: MutableRefObject<ViewerState | null>;
}

export function PhotoGallery({
  photos,
  gridMode = 'medium',
  selectedPhotoIds = new Set(),
  onSelectionChange,
  onGridModeChange,
  onIsFilmstripChange,
  onDeletePhoto,
  onToggleFavorite,
  viewerStateRef,
}: PhotoGalleryProps) {
  const [mode, setMode] = useState<ViewMode>(gridMode);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const prevGridMode = useRef<GridMode>(gridMode);
  const tileRefs = useRef<Array<HTMLDivElement | null>>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const isFilmstrip = mode === 'filmstrip';

  // Sync external gridMode changes
  useEffect(() => {
    if (mode !== 'filmstrip') {
      setMode(gridMode);
      prevGridMode.current = gridMode;
    }
  }, [gridMode, mode]);

  useEffect(() => {
    setFocusedIndex((idx) => Math.max(0, Math.min(idx, photos.length - 1)));
  }, [photos.length]);

  useEffect(() => {
    onIsFilmstripChange?.(isFilmstrip);
    if (!isFilmstrip) {
      onGridModeChange?.(mode as GridMode);
    }
  }, [isFilmstrip, mode, onGridModeChange, onIsFilmstripChange]);

  useEffect(() => {
    if (isFilmstrip || photos.length === 0) return;
    const frame = requestAnimationFrame(() => {
      gridRef.current?.focus();
      setFocusedIndex((idx) => Math.max(0, Math.min(idx, photos.length - 1)));
    });
    return () => cancelAnimationFrame(frame);
  }, [isFilmstrip, photos.length]);

  function enterFilmstrip(idx: number) {
    if (mode !== 'filmstrip') prevGridMode.current = mode as GridMode;
    setViewerIndex(idx);
    setMode('filmstrip');
  }

  function exitFilmstrip() {
    setMode(prevGridMode.current);
  }

  function togglePhotoSelection(photoId: string) {
    const newSelection = new Set(selectedPhotoIds);
    if (newSelection.has(photoId)) {
      newSelection.delete(photoId);
    } else {
      newSelection.add(photoId);
    }
    onSelectionChange?.(newSelection);
  }

  function handleTileClick(idx: number, event: MouseEvent<HTMLDivElement>) {
    setFocusedIndex(idx);
    // If shift/ctrl/cmd key is held, toggle selection instead of opening viewer
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      event.stopPropagation();
      togglePhotoSelection(photos[idx].id);
    } else {
      enterFilmstrip(idx);
    }
  }

  function getColumnCount() {
    if (tileRefs.current.length === 0) return 1;
    const first = tileRefs.current[0];
    if (!first) return 1;
    const firstTop = first.offsetTop;
    let count = 0;
    for (const tile of tileRefs.current) {
      if (!tile) continue;
      if (tile.offsetTop !== firstTop) break;
      count += 1;
    }
    return Math.max(1, count);
  }

  function moveFocus(nextIndex: number) {
    const clamped = Math.max(0, Math.min(nextIndex, photos.length - 1));
    setFocusedIndex(clamped);
  }

  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null;
    if (target?.tagName === 'INPUT') return;

    const idx = focusedIndex;
    const columns = getColumnCount();
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveFocus(idx + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveFocus(idx - 1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(idx + columns);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(idx - columns);
        break;
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        togglePhotoSelection(photos[idx].id);
        break;
      case 'Enter':
        event.preventDefault();
        enterFilmstrip(idx);
        break;
      default:
        break;
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
      <div
        ref={gridRef}
        className={`photo-grid-gallery photo-grid-gallery--${mode}`}
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
      >
        {photos.map((photo, idx) => {
          const isSelected = selectedPhotoIds.has(photo.id);
          return (
            <div
              key={photo.id}
              ref={(el) => {
                tileRefs.current[idx] = el;
              }}
              className={`gallery-tile${mode === 'large' ? ' gallery-tile--large' : ''}${isSelected ? ' gallery-tile--selected' : ''}`}
              onClick={(e) => handleTileClick(idx, e)}
              onMouseEnter={() => setFocusedIndex(idx)}
              data-focused={idx === focusedIndex ? 'true' : 'false'}
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
                    togglePhotoSelection(photo.id);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Select ${photo.originalName}`}
                />
              </div>

              <LazyImage photo={photo} className="gallery-tile-img" alt={photo.originalName} />
              {mode === 'large' && <p className="gallery-tile-name">{photo.originalName}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
