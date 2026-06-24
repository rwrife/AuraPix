import { useEffect, useRef, useState, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PhotoGallery } from '../components/PhotoGallery';
import { GRID_BUTTONS, type GridMode } from '../components/photoGalleryConfig';
import type { ViewerState } from '../components/PhotoViewer';
import { UploadModal } from '../components/UploadModal';
import { Toolbar } from '../components/toolbar';
import { ViewerToolbar } from '../components/toolbar';
import { createViewerToolbarConfig } from '../components/toolbar/examples/viewerToolbarConfig';
import type { ToolbarButton, ModalContentProps } from '../components/toolbar';
import { useAuth } from '../features/auth/useAuth';
import { useAlbums } from '../features/albums/useAlbums';
import { useLibrary } from '../features/library/useLibrary';
import {
  deleteQuickViewPreset,
  loadQuickViewPreferences,
  loadSavedQuickViewPresets,
  saveQuickViewPreferences,
  saveQuickViewPreset,
  type LibrarySavedQuickViewPreset,
} from '../features/library/quickViewPreferences';
import { useUploadSessions } from '../features/uploads/useUploadSessions';
import { useServices } from '../services/useServices';
import type { LibrarySort, LibraryUsageSummary, Photo } from '../domain/library/types';

function toLibraryId(userId: string) {
  return `library-${userId}`;
}

interface ParsedSearchFilters {
  text: string;
  tags: string[];
  cameraMake: string | null;
  collection: 'favorites' | 'tagged' | 'untagged' | 'recent' | null;
}

function parseSearchFilters(query: string): ParsedSearchFilters {
  const parts = query
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const tags: string[] = [];
  let cameraMake: string | null = null;
  let collection: ParsedSearchFilters['collection'] = null;
  const textParts: string[] = [];

  for (const part of parts) {
    const [rawKey, ...rest] = part.split(':');
    if (rest.length === 0) {
      textParts.push(part);
      continue;
    }

    const key = rawKey.toLowerCase();
    const value = rest.join(':').trim();
    if (!value) continue;

    if (key === 'tag') {
      tags.push(value.toLowerCase());
      continue;
    }

    if (key === 'camera') {
      cameraMake = value.toLowerCase();
      continue;
    }

    if (key === 'collection') {
      const normalized = value.toLowerCase();
      if (
        normalized === 'favorites' ||
        normalized === 'tagged' ||
        normalized === 'untagged' ||
        normalized === 'recent'
      ) {
        collection = normalized;
        continue;
      }
    }

    textParts.push(part);
  }

  return {
    text: textParts.join(' ').trim().toLowerCase(),
    tags,
    cameraMake,
    collection,
  };
}

function matchesSearchFilters(photo: Photo, parsed: ParsedSearchFilters): boolean {
  if (parsed.tags.length > 0) {
    const normalizedPhotoTags = photo.tags.map((tag) => tag.toLowerCase());
    const hasAllTags = parsed.tags.every((tag) => normalizedPhotoTags.includes(tag));
    if (!hasAllTags) return false;
  }

  if (parsed.cameraMake) {
    const photoCamera = photo.metadata?.cameraMake?.toLowerCase() ?? '';
    if (!photoCamera.includes(parsed.cameraMake)) return false;
  }

  if (parsed.collection === 'favorites' && !photo.isFavorite) return false;
  if (parsed.collection === 'tagged' && photo.tags.length === 0) return false;
  if (parsed.collection === 'untagged' && photo.tags.length > 0) return false;
  if (parsed.collection === 'recent') {
    const photoAgeMs = Date.now() - new Date(photo.createdAt).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    if (photoAgeMs > thirtyDaysMs) return false;
  }

  if (!parsed.text) return true;
  const haystack = [
    photo.originalName,
    ...(photo.tags ?? []),
    photo.metadata?.cameraMake ?? '',
    photo.metadata?.cameraModel ?? '',
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(parsed.text);
}

export function LibraryPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const libraryId = toLibraryId(user?.id ?? 'local-user-1');
  const initialQuickViewPreferences = useMemo(
    () => loadQuickViewPreferences(libraryId),
    [libraryId]
  );
  const [cameraMakeFilter, setCameraMakeFilter] = useState<string>(
    initialQuickViewPreferences.cameraMakeFilter
  );
  const [quickCollection, setQuickCollection] = useState<
    'all' | 'favorites' | 'tagged' | 'untagged' | 'recent'
  >(initialQuickViewPreferences.quickCollection);
  const [activeTagFilter, setActiveTagFilter] = useState<string>(
    initialQuickViewPreferences.activeTagFilter
  );
  const [sortOrder, setSortOrder] = useState<LibrarySort>('created_desc');
  const [gridMode, setGridMode] = useState<GridMode>(initialQuickViewPreferences.gridMode);
  const [savedQuickViews, setSavedQuickViews] = useState<LibrarySavedQuickViewPreset[]>(() =>
    loadSavedQuickViewPresets(libraryId)
  );
  const [selectedQuickViewId, setSelectedQuickViewId] = useState<string>('');
  const [quickViewNameInput, setQuickViewNameInput] = useState<string>('');
  const searchQuery = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('q')?.trim() ?? '';
  }, [location.search]);
  const parsedSearch = useMemo(() => parseSearchFilters(searchQuery), [searchQuery]);

  const metadataFilters = useMemo(
    () => ({
      metadata: cameraMakeFilter ? { cameraMake: cameraMakeFilter } : undefined,
      favoritesOnly: quickCollection === 'favorites',
      collection: quickCollection === 'all' ? undefined : quickCollection,
      tags: activeTagFilter ? [activeTagFilter] : undefined,
      sort: sortOrder,
    }),
    [cameraMakeFilter, quickCollection, activeTagFilter, sortOrder]
  );

  useEffect(() => {
    saveQuickViewPreferences(libraryId, {
      quickCollection,
      activeTagFilter,
      cameraMakeFilter,
      gridMode,
    });
  }, [libraryId, quickCollection, activeTagFilter, cameraMakeFilter, gridMode]);

  useEffect(() => {
    setSavedQuickViews(loadSavedQuickViewPresets(libraryId));
    setSelectedQuickViewId('');
    setQuickViewNameInput('');
  }, [libraryId]);

  const {
    photos,
    loading,
    error,
    hasMore,
    loadingMore,
    loadMore,
    addPhoto,
    assignToAlbum,
    bulkAddToAlbum,
    toggleFavorite,
    setRating,
    setFlag,
    setColorLabel,
    setTags,
    deletePhoto,
  } = useLibrary(libraryId, metadataFilters);
  const { albums } = useAlbums();
  const { library: libraryService, uploads: uploadSessionsService } = useServices();
  const {
    pendingSession,
    metadata: uploadedMetadata,
    jobs: derivativeJobs,
    replayedFinalize,
    createAndFinalizeSession,
    processNextDerivativeJob,
  } = useUploadSessions(uploadSessionsService);

  const [isFilmstrip, setIsFilmstrip] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
  const [bulkAlbumId, setBulkAlbumId] = useState<string>('');
  const [bulkTagInput, setBulkTagInput] = useState<string>('');
  const [bulkActionMessage, setBulkActionMessage] = useState<string | null>(null);
  const [usageSummary, setUsageSummary] = useState<LibraryUsageSummary | null>(null);
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

  // Lightroom-style triage shortcuts: 0–5 rating; P=pick, X=reject; ~=clear flag.
  // Only fires when the user is not typing into an input/textarea/contentEditable
  // and exactly one photo is selected (or focused in the filmstrip viewer).
  useEffect(() => {
    function isEditableTarget(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    }

    function targetPhotoId(): string | null {
      if (selectedPhotoIds.size === 1) {
        return Array.from(selectedPhotoIds)[0];
      }
      const viewerId = viewerStateRef.current?.currentPhoto?.id ?? null;
      return viewerId;
    }

    function handleKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      const photoId = targetPhotoId();
      if (!photoId) return;

      const key = event.key;
      if (key >= '0' && key <= '5') {
        const rating = Number(key) as 0 | 1 | 2 | 3 | 4 | 5;
        event.preventDefault();
        void setRating(photoId, rating);
        return;
      }

      const lower = key.toLowerCase();
      if (lower === 'p') {
        event.preventDefault();
        void setFlag(photoId, 'pick');
      } else if (lower === 'x') {
        event.preventDefault();
        void setFlag(photoId, 'reject');
      } else if (key === '`' || key === '~') {
        event.preventDefault();
        void setFlag(photoId, null);
      } else if (lower === 'r') {
        // Lightroom-style color labels (issue #184). r/y/g/b/u (=purple)
        // are mnemonic; press the same key twice to clear (handled by
        // toggling against the current value).
        event.preventDefault();
        void setColorLabel(
          photoId,
          viewerState?.currentPhoto.id === photoId &&
            viewerState.currentPhoto.colorLabel === 'red'
            ? null
            : 'red'
        );
      } else if (lower === 'y') {
        event.preventDefault();
        void setColorLabel(
          photoId,
          viewerState?.currentPhoto.id === photoId &&
            viewerState.currentPhoto.colorLabel === 'yellow'
            ? null
            : 'yellow'
        );
      } else if (lower === 'g') {
        event.preventDefault();
        void setColorLabel(
          photoId,
          viewerState?.currentPhoto.id === photoId &&
            viewerState.currentPhoto.colorLabel === 'green'
            ? null
            : 'green'
        );
      } else if (lower === 'b') {
        event.preventDefault();
        void setColorLabel(
          photoId,
          viewerState?.currentPhoto.id === photoId &&
            viewerState.currentPhoto.colorLabel === 'blue'
            ? null
            : 'blue'
        );
      } else if (lower === 'u') {
        event.preventDefault();
        void setColorLabel(
          photoId,
          viewerState?.currentPhoto.id === photoId &&
            viewerState.currentPhoto.colorLabel === 'purple'
            ? null
            : 'purple'
        );
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedPhotoIds, setRating, setFlag, setColorLabel, viewerState]);

  // Handle upload modal trigger from URL query parameter
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('upload') !== '1') return;

    setShowUploadModal(true);
    params.delete('upload');
    const search = params.toString();
    navigate(
      {
        pathname: location.pathname, // Use current pathname instead of hardcoded '/library'
        search: search ? `?${search}` : '',
      },
      { replace: true }
    );
  }, [location.search, location.pathname, navigate]);

  // Handle upload modal trigger from custom event (for embedded scenarios)
  useEffect(() => {
    function handleOpenUploadModal() {
      setShowUploadModal(true);
    }

    window.addEventListener('huddlepix:open-upload-modal', handleOpenUploadModal);
    return () => {
      window.removeEventListener('huddlepix:open-upload-modal', handleOpenUploadModal);
    };
  }, []);

  async function handleUpload(
    files: File[],
    albumId: string | null,
    onProgress: (completed: number, total: number) => void
  ) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const uploadRequestId = `${file.name}-${file.size}-${file.lastModified}-${i}`;
      await createAndFinalizeSession(file.name, file.size, uploadRequestId);

      const photo = await addPhoto(file);
      if (albumId) await assignToAlbum(photo.id, albumId, photo);
      onProgress(i + 1, files.length);
    }
  }

  async function handleBulkAddToAlbum() {
    if (!bulkAlbumId || selectedPhotoIds.size === 0) return;

    const result = await bulkAddToAlbum([...selectedPhotoIds], bulkAlbumId);
    const albumName = albums.find((album) => album.id === bulkAlbumId)?.name ?? 'album';

    const addedCount = result.results.filter((item) => item.status === 'added').length;
    const alreadyInAlbumCount = result.results.filter(
      (item) => item.status === 'skipped' && item.code === 'already_in_album'
    ).length;
    const missingCount = result.results.filter(
      (item) => item.status === 'skipped' && item.code === 'not_found'
    ).length;

    const messageParts = [`Added ${addedCount} photo(s) to “${albumName}”.`];
    if (alreadyInAlbumCount > 0) {
      messageParts.push(`${alreadyInAlbumCount} already in album.`);
    }
    if (missingCount > 0) {
      messageParts.push(`${missingCount} no longer available.`);
    }

    setBulkActionMessage(messageParts.join(' '));
    setSelectedPhotoIds(new Set());
  }

  async function handleBulkTagApply() {
    const nextTag = bulkTagInput.trim().toLowerCase();
    if (!nextTag || selectedPhotoIds.size === 0) return;

    const selectedPhotos = photos.filter((photo) => selectedPhotoIds.has(photo.id));
    for (const photo of selectedPhotos) {
      const normalizedTags = Array.from(
        new Set([...photo.tags.map((tag) => tag.toLowerCase()), nextTag])
      );
      await setTags(photo.id, normalizedTags);
    }

    setBulkActionMessage(`Tagged ${selectedPhotos.length} photo(s) with #${nextTag}.`);
    setBulkTagInput('');
  }

  // Viewer toolbar configuration
  const viewerToolbarButtons = useMemo<ToolbarButton[]>(() => {
    if (!viewerState) return [];

    return createViewerToolbarConfig({
      currentPhoto: viewerState.currentPhoto,
      onToggleFavorite: viewerState.onToggleFavorite,
      onSetColorLabel: (label) =>
        void setColorLabel(viewerState.currentPhoto.id, label),
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
  }, [viewerState, deletePhoto, photos.length, setColorLabel]);

  const availableTags = useMemo(
    () => [...new Set(photos.flatMap((photo) => photo.tags))].sort((a, b) => a.localeCompare(b)),
    [photos]
  );
  const topQuickTags = useMemo(() => availableTags.slice(0, 4), [availableTags]);
  const visiblePhotos = useMemo(() => {
    if (!searchQuery) return photos;
    return photos.filter((photo) => matchesSearchFilters(photo, parsedSearch));
  }, [photos, searchQuery, parsedSearch]);

  const queuedDerivativeJobs = derivativeJobs.filter((job) => job.status === 'queued').length;
  const completedDerivativeJobs = derivativeJobs.filter((job) => job.status === 'completed').length;

  useEffect(() => {
    let cancelled = false;
    libraryService
      .getUsage(libraryId)
      .then((summary) => {
        if (!cancelled) {
          setUsageSummary(summary);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUsageSummary(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [libraryService, libraryId, photos.length]);

  const formattedUsageBytes = useMemo(() => {
    if (!usageSummary) return '';
    if (usageSummary.totalBytes < 1024 * 1024) {
      return `${Math.max(1, Math.round(usageSummary.totalBytes / 1024))} KB`;
    }
    return `${(usageSummary.totalBytes / (1024 * 1024)).toFixed(1)} MB`;
  }, [usageSummary]);

  // Gallery toolbar configuration
  const galleryToolbarButtons = useMemo<ToolbarButton[]>(() => {
    return [
      {
        type: 'toggle',
        id: 'favorite',
        icon: '♥',
        title: 'Toggle favorite',
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
        type: 'modal',
        id: 'delete',
        icon: '✕',
        title: 'Delete selected',
        className: 'btn-danger-ghost',
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

  function applySavedQuickView(presetId: string) {
    setSelectedQuickViewId(presetId);
    const preset = savedQuickViews.find((item) => item.id === presetId);
    if (!preset) return;
    setQuickCollection(preset.preferences.quickCollection);
    setActiveTagFilter(preset.preferences.activeTagFilter);
    setCameraMakeFilter(preset.preferences.cameraMakeFilter);
    setGridMode(preset.preferences.gridMode);
  }

  function handleSaveQuickView() {
    if (!quickViewNameInput.trim()) return;
    const next = saveQuickViewPreset(libraryId, quickViewNameInput, {
      quickCollection,
      activeTagFilter,
      cameraMakeFilter,
      gridMode,
    });
    setSavedQuickViews(next);
    const saved = next.find(
      (preset) => preset.name.toLowerCase() === quickViewNameInput.trim().toLowerCase()
    );
    setSelectedQuickViewId(saved?.id ?? '');
    setQuickViewNameInput('');
  }

  function handleDeleteSelectedQuickView() {
    if (!selectedQuickViewId) return;
    const next = deleteQuickViewPreset(libraryId, selectedQuickViewId);
    setSavedQuickViews(next);
    setSelectedQuickViewId('');
  }

  function removeSearchToken(token: string) {
    const nextQuery = searchQuery
      .split(/\s+/)
      .filter((part) => part.trim() && part !== token)
      .join(' ')
      .trim();

    const params = new URLSearchParams(location.search);
    if (nextQuery) {
      params.set('q', nextQuery);
    } else {
      params.delete('q');
    }

    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params.toString()}` : '',
      },
      { replace: true }
    );
  }

  return (
    <>
      <div className="page-titlebar">
        <h1 className="page-title">Library</h1>
        {searchQuery && (
          <div className="titlebar-controls" style={{ marginBottom: 8 }}>
            {parsedSearch.text && (
              <span className="btn-ghost btn-sm" title="Free text search term">
                text: {parsedSearch.text}
              </span>
            )}
            {parsedSearch.collection && (
              <button
                className="btn-ghost btn-sm"
                title="Remove collection filter"
                onClick={() => removeSearchToken(`collection:${parsedSearch.collection}`)}
              >
                collection:{parsedSearch.collection} ✕
              </button>
            )}
            {parsedSearch.cameraMake && (
              <button
                className="btn-ghost btn-sm"
                title="Remove camera filter"
                onClick={() => removeSearchToken(`camera:${parsedSearch.cameraMake}`)}
              >
                camera:{parsedSearch.cameraMake} ✕
              </button>
            )}
            {parsedSearch.tags.map((tag) => (
              <button
                key={tag}
                className="btn-ghost btn-sm"
                title={`Remove tag:${tag} filter`}
                onClick={() => removeSearchToken(`tag:${tag}`)}
              >
                tag:{tag} ✕
              </button>
            ))}
          </div>
        )}
        {usageSummary && !isFilmstrip && (
          <p className="state-message" role="status" aria-live="polite">
            Usage: {usageSummary.totalPhotos} photo(s) · {formattedUsageBytes} ·{' '}
            {usageSummary.favoritePhotos} favorites · {usageSummary.taggedPhotos} tagged
          </p>
        )}
        {!isFilmstrip && visiblePhotos.length > 0 && (
          <div className="titlebar-controls">
            <button
              className={`btn-ghost btn-sm${quickCollection === 'all' ? ' active' : ''}`}
              title="Show all photos"
              onClick={() => setQuickCollection('all')}
            >
              All
            </button>
            <button
              className={`btn-ghost btn-sm${quickCollection === 'favorites' ? ' active' : ''}`}
              title="Show favorites"
              onClick={() => setQuickCollection('favorites')}
            >
              Favorites
            </button>
            <button
              className={`btn-ghost btn-sm${quickCollection === 'tagged' ? ' active' : ''}`}
              title="Show tagged photos"
              onClick={() => setQuickCollection('tagged')}
            >
              Tagged
            </button>
            <button
              className={`btn-ghost btn-sm${quickCollection === 'untagged' ? ' active' : ''}`}
              title="Show untagged photos"
              onClick={() => setQuickCollection('untagged')}
            >
              Untagged
            </button>
            <button
              className={`btn-ghost btn-sm${quickCollection === 'recent' ? ' active' : ''}`}
              title="Show recent photos"
              onClick={() => setQuickCollection('recent')}
            >
              Recent
            </button>
            <select
              className="btn-ghost btn-sm"
              aria-label="Apply saved quick view"
              value={selectedQuickViewId}
              onChange={(e) => applySavedQuickView(e.target.value)}
            >
              <option value="">Saved views…</option>
              {savedQuickViews.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <input
              className="btn-ghost btn-sm"
              aria-label="Name quick view"
              placeholder="Save view as…"
              value={quickViewNameInput}
              onChange={(e) => setQuickViewNameInput(e.target.value)}
            />
            <button
              className="btn-ghost btn-sm"
              title="Save current quick view"
              onClick={handleSaveQuickView}
              disabled={!quickViewNameInput.trim()}
            >
              Save View
            </button>
            <button
              className="btn-danger-ghost btn-sm"
              title="Delete selected quick view"
              onClick={handleDeleteSelectedQuickView}
              disabled={!selectedQuickViewId}
            >
              Delete View
            </button>
            <select
              className="btn-ghost btn-sm"
              aria-label="Filter by tag"
              value={activeTagFilter}
              onChange={(e) => setActiveTagFilter(e.target.value)}
            >
              <option value="">All tags</option>
              {availableTags.map((tag) => (
                <option key={tag} value={tag}>
                  #{tag}
                </option>
              ))}
            </select>
            {topQuickTags.map((tag) => (
              <button
                key={tag}
                className={`btn-ghost btn-sm${activeTagFilter === tag ? ' active' : ''}`}
                title={`Filter by #${tag}`}
                onClick={() => setActiveTagFilter(activeTagFilter === tag ? '' : tag)}
              >
                #{tag}
              </button>
            ))}
            <select
              className="btn-ghost btn-sm"
              aria-label="Filter by camera make"
              value={cameraMakeFilter}
              onChange={(e) => setCameraMakeFilter(e.target.value)}
            >
              <option value="">All cameras</option>
              {[...new Set(photos.map((photo) => photo.metadata?.cameraMake).filter(Boolean))].map(
                (cameraMake) => (
                  <option key={cameraMake} value={cameraMake ?? ''}>
                    {cameraMake}
                  </option>
                )
              )}
            </select>
            <select
              className="btn-ghost btn-sm"
              aria-label="Sort photos"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as LibrarySort)}
            >
              <option value="created_desc">Newest first</option>
              <option value="created_asc">Oldest first</option>
              <option value="name_asc">Name A–Z</option>
              <option value="name_desc">Name Z–A</option>
            </select>
            <button
              className="btn-ghost btn-sm"
              title="Select all"
              onClick={() => setSelectedPhotoIds(new Set(visiblePhotos.map((p) => p.id)))}
            >
              ☑
            </button>
            {GRID_BUTTONS.map(({ mode, icon, title }) => (
              <button
                key={mode}
                className={`btn-ghost btn-sm${gridMode === mode ? ' active' : ''}`}
                title={title}
                onClick={() => setGridMode(mode)}
              >
                {icon}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={`page-with-toolbar${isFilmstrip ? ' page--viewer-mode' : ''}`}>
        <div className="page-center-column">
          {error && <p className="error">{error}</p>}

          {(pendingSession || uploadedMetadata.length > 0) && (
            <div className="state-message" role="status" aria-live="polite">
              <strong>Upload pipeline:</strong> {uploadedMetadata.length} finalized ·{' '}
              {queuedDerivativeJobs} queued · {completedDerivativeJobs} completed
              {pendingSession ? ` · latest key ${pendingSession.objectKey}` : ''}
              {replayedFinalize ? ' · idempotent replay detected' : ''}
              {queuedDerivativeJobs > 0 ? (
                <>
                  {' '}
                  ·{' '}
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => void processNextDerivativeJob()}
                  >
                    Run derivative worker tick
                  </button>
                </>
              ) : (
                ''
              )}
            </div>
          )}

          {loading ? (
            <p className="state-message">Loading library…</p>
          ) : visiblePhotos.length === 0 ? (
            <div className="empty-state">
              <p>No photos yet.</p>
              <p>
                Click <strong>Add Photos</strong> in the top bar to add images.
              </p>
            </div>
          ) : (
            <PhotoGallery
              photos={visiblePhotos}
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

          {!loading && hasMore && !isFilmstrip && (
            <div className="pagination-controls">
              <button className="btn-ghost btn-sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
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
          <span className="floating-selection-toolbar-count">{selectedPhotoIds.size} selected</span>
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
            <select
              className="btn-ghost btn-sm"
              aria-label="Select album for bulk add"
              value={bulkAlbumId}
              onChange={(e) => setBulkAlbumId(e.target.value)}
              disabled={albums.length === 0}
            >
              <option value="">Add to album…</option>
              {albums.map((album) => (
                <option key={album.id} value={album.id}>
                  {album.name}
                </option>
              ))}
            </select>
            <button
              className="btn-ghost btn-sm"
              onClick={handleBulkAddToAlbum}
              title="Add selected photos to album"
              disabled={!bulkAlbumId || selectedPhotoIds.size === 0}
            >
              + Album
            </button>
            <input
              className="btn-ghost btn-sm"
              aria-label="Tag selected photos"
              placeholder="tag"
              value={bulkTagInput}
              onChange={(e) => setBulkTagInput(e.target.value)}
            />
            <button
              className="btn-ghost btn-sm"
              onClick={handleBulkTagApply}
              title="Apply tag to selected photos"
              disabled={!bulkTagInput.trim() || selectedPhotoIds.size === 0}
            >
              + Tag
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
          {bulkActionMessage && (
            <span className="state-message" role="status" aria-live="polite">
              {bulkActionMessage}
            </span>
          )}
        </div>
      )}

      {showUploadModal && (
        <UploadModal onClose={() => setShowUploadModal(false)} onUpload={handleUpload} />
      )}
    </>
  );
}
