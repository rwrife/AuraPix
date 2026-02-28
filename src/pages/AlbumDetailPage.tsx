import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PhotoGallery } from '../components/PhotoGallery';
import { GRID_BUTTONS, type GridMode } from '../components/photoGalleryConfig';
import type { ViewerState } from '../components/PhotoViewer';
import { UploadModal } from '../components/UploadModal';
import type { Photo } from '../domain/library/types';
import type {
  ResolveShareDownloadInput,
  ShareDownloadPolicy,
  SharePermission,
} from '../domain/sharing/types';
import { useAlbums } from '../features/albums/useAlbums';
import { useAuth } from '../features/auth/useAuth';
import { useLibrary } from '../features/library/useLibrary';
import { useSharing } from '../features/sharing/useSharing';
import { useServices } from '../services/useServices';

function toLibraryId(userId: string) {
  return `library-${userId}`;
}

export function AlbumDetailPage() {
  const { albumId } = useParams<{ albumId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    albums,
    folders,
    loading: albumsLoading,
    error: albumsError,
    renameAlbum,
    moveAlbum,
    deleteAlbum,
  } = useAlbums();
  const { library } = useServices();
  const libraryId = toLibraryId(user?.id ?? 'local-user-1');

  const {
    photos: allPhotos,
    loading: libraryLoading,
    addPhoto,
    assignToAlbum,
    refresh,
    deletePhoto,
    toggleFavorite,
  } = useLibrary(libraryId);

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [isFilmstrip, setIsFilmstrip] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [folderInput, setFolderInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [gridMode, setGridMode] = useState<GridMode>('medium');
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
  const viewerStateRef = useRef<ViewerState | null>(null);
  const [viewerState, setViewerState] = useState<ViewerState | null>(null);
  const [shareExpiryInput, setShareExpiryInput] = useState('');
  const [sharePasswordInput, setSharePasswordInput] = useState('');
  const [sharePermissionInput, setSharePermissionInput] = useState<SharePermission>('view');
  const [shareDownloadPolicyInput, setShareDownloadPolicyInput] =
    useState<ShareDownloadPolicy>('none');
  const [shareWatermarkEnabled, setShareWatermarkEnabled] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareDownloadProbeMessage, setShareDownloadProbeMessage] = useState<Record<string, string>>(
    {}
  );
  const [shareDownloadProbeBusy, setShareDownloadProbeBusy] = useState<Record<string, boolean>>({});

  const {
    links: shareLinks,
    accessEvents: shareAccessEvents,
    loading: shareLoading,
    loadingAccessEvents,
    accessEventsError,
    createLink,
    revokeLink,
    updateLinkPolicy,
    refreshAccessEvents,
    resolveDownload,
  } = useSharing(albumId ?? '');

  const album = albums.find((a) => a.id === albumId) ?? null;

  const albumPhotos = allPhotos.filter((p) => albumId != null && p.albumIds.includes(albumId));

  useEffect(() => {
    if (sharePermissionInput !== 'download') {
      setShareDownloadPolicyInput('none');
      setShareWatermarkEnabled(false);
      return;
    }

    if (shareDownloadPolicyInput === 'none') {
      setShareDownloadPolicyInput('original_and_derivative');
    }
  }, [sharePermissionInput, shareDownloadPolicyInput]);

  useEffect(() => {
    if (!album) return;
    setNameInput(album.name);
    setFolderInput(album.folderId ?? '');
  }, [album]);

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

  // ESC key to close panel
  useEffect(() => {
    if (!isFilmstrip || !viewerState?.activeTool) return;

    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape' && viewerState?.activeTool) {
        viewerState.setActiveTool(null);
      }
    }

    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isFilmstrip, viewerState]);

  async function handleUpload(
    files: File[],
    targetAlbumId: string | null,
    onProgress: (completed: number, total: number) => void
  ) {
    for (let i = 0; i < files.length; i++) {
      const photo = await addPhoto(files[i]);
      if (targetAlbumId) await assignToAlbum(photo.id, targetAlbumId, photo);
      onProgress(i + 1, files.length);
    }
  }

  const removeFromAlbum = useCallback(
    async (photo: Photo) => {
      if (!albumId) return;
      const newAlbumIds = photo.albumIds.filter((id) => id !== albumId);
      await library.updatePhoto(photo.id, { albumIds: newAlbumIds });
      refresh();
    },
    [library, albumId, refresh]
  );

  async function handleDeleteAlbum() {
    if (!albumId) return;
    if (!confirm(`Delete album "${album?.name}"? Photos will not be deleted.`)) return;
    await deleteAlbum(albumId);
    navigate('/albums');
  }

  async function handleSaveSettings() {
    if (!albumId || !album) return;
    const trimmedName = nameInput.trim();
    if (!trimmedName) return;

    setSaving(true);
    if (trimmedName !== album.name) {
      await renameAlbum(albumId, trimmedName);
    }

    const nextFolderId = folderInput === '' ? null : folderInput;
    const currentFolderId = album.folderId ?? null;
    if (nextFolderId !== currentFolderId) {
      await moveAlbum(albumId, nextFolderId);
    }
    setSaving(false);
  }



  async function toggleShareWatermark(linkId: string, enabled: boolean) {
    setShareError(null);
    try {
      await updateLinkPolicy(linkId, { watermarkEnabled: enabled });
    } catch (error) {
      setShareError(error instanceof Error ? error.message : 'Failed to update share link.');
    }
  }

  async function cycleShareDownloadPolicy(link: (typeof shareLinks)[number]) {
    const sequence: ShareDownloadPolicy[] = ['none', 'derivative_only', 'original_and_derivative'];
    const current = sequence.indexOf(link.policy.downloadPolicy);
    const next = sequence[(current + 1) % sequence.length];

    setShareError(null);
    try {
      await updateLinkPolicy(link.id, {
        downloadPolicy: next,
        watermarkEnabled: next === 'none' ? false : link.policy.watermarkEnabled,
      });
    } catch (error) {
      setShareError(error instanceof Error ? error.message : 'Failed to update share link.');
    }
  }

  async function toggleSharePermission(link: (typeof shareLinks)[number]) {
    const nextPermission: SharePermission =
      link.policy.permission === 'download' ? 'view' : 'download';

    setShareError(null);
    try {
      await updateLinkPolicy(link.id, {
        permission: nextPermission,
        downloadPolicy:
          nextPermission === 'download'
            ? link.policy.downloadPolicy === 'none'
              ? 'original_and_derivative'
              : link.policy.downloadPolicy
            : 'none',
        watermarkEnabled: nextPermission === 'download' ? link.policy.watermarkEnabled : false,
      });
    } catch (error) {
      setShareError(error instanceof Error ? error.message : 'Failed to update share permission.');
    }
  }

  async function handleCreateShareLink() {
    if (!albumId) return;
    setShareError(null);

    try {
      await createLink('album', albumId, {
        expiresAt: shareExpiryInput ? new Date(shareExpiryInput).toISOString() : undefined,
        password: sharePasswordInput || undefined,
        permission: sharePermissionInput,
        downloadPolicy: shareDownloadPolicyInput,
        watermarkEnabled: shareWatermarkEnabled,
      });
      setSharePasswordInput('');
    } catch (error) {
      setShareError(error instanceof Error ? error.message : 'Failed to create share link.');
    }
  }

  async function revokeExpiredLinks() {
    if (expiredShareLinks.length === 0) return;

    setShareError(null);
    try {
      await Promise.all(expiredShareLinks.map((link) => revokeLink(link.id)));
      await refreshAccessEvents();
    } catch (error) {
      setShareError(error instanceof Error ? error.message : 'Failed to revoke expired links.');
    }
  }

  async function probeShareDownload(
    link: (typeof shareLinks)[number],
    assetKind: ResolveShareDownloadInput['assetKind']
  ) {
    const probeKey = `${link.id}:${assetKind}`;
    setShareDownloadProbeBusy((prev) => ({ ...prev, [probeKey]: true }));
    setShareError(null);

    try {
      const password = link.policy.passwordProtected
        ? (window.prompt(`Enter password for ${assetKind} download probe`, '') ?? undefined)
        : undefined;

      const resolution = await resolveDownload(link.token, assetKind, password);
      const message = resolution
        ? `${assetKind} download granted${resolution.watermarkApplied ? ' (watermarked)' : ''}`
        : `${assetKind} download denied by policy`;
      setShareDownloadProbeMessage((prev) => ({ ...prev, [probeKey]: message }));
      await refreshAccessEvents();
    } catch (error) {
      setShareError(error instanceof Error ? error.message : 'Failed to probe share download policy.');
    } finally {
      setShareDownloadProbeBusy((prev) => ({ ...prev, [probeKey]: false }));
    }
  }

  const hasSettingsChanges =
    album != null &&
    (nameInput.trim() !== album.name ||
      (folderInput === '' ? null : folderInput) !== (album.folderId ?? null));

  const grantedShareAccessCount = shareAccessEvents.filter((event) =>
    event.outcome.startsWith('granted')
  ).length;
  const deniedShareAccessCount = shareAccessEvents.length - grantedShareAccessCount;
  const nowMs = Date.now();
  const expiredShareLinks = shareLinks.filter((link) => {
    if (!link.policy.expiresAt) return false;
    return new Date(link.policy.expiresAt).getTime() <= nowMs;
  });
  const expiredShareLinkIds = new Set(expiredShareLinks.map((link) => link.id));

  if (albumsLoading) return <p className="state-message">Loading album…</p>;

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
    <>
      <div className="page-titlebar">
        <h1 className="page-title">{album.name}</h1>
        {!isFilmstrip && albumPhotos.length > 0 && (
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
              onClick={() => setSelectedPhotoIds(new Set(albumPhotos.map((p) => p.id)))}
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

      <section className="settings-panel" style={{ marginBottom: 12 }}>
        <h2 className="settings-heading">Share album</h2>
        <p className="state-message" style={{ marginTop: 0 }}>
          Create private links with optional expiry/password. Existing links can be revoked.
        </p>
        <div className="settings-grid" style={{ alignItems: 'end' }}>
          <label className="settings-label" htmlFor="share-expiry">
            Expires at
          </label>
          <input
            id="share-expiry"
            type="datetime-local"
            value={shareExpiryInput}
            onChange={(e) => setShareExpiryInput(e.target.value)}
          />
          <label className="settings-label" htmlFor="share-password">
            Password (optional)
          </label>
          <input
            id="share-password"
            type="password"
            value={sharePasswordInput}
            onChange={(e) => setSharePasswordInput(e.target.value)}
            placeholder="Leave blank for no password"
          />

          <label className="settings-label" htmlFor="share-permission">
            Permission
          </label>
          <select
            id="share-permission"
            className="settings-select"
            value={sharePermissionInput}
            onChange={(e) => setSharePermissionInput(e.target.value as SharePermission)}
          >
            <option value="view">View only</option>
            <option value="download">Download allowed</option>
            <option value="collaborate">Collaborate</option>
          </select>

          <label className="settings-label" htmlFor="share-download-policy">
            Download policy
          </label>
          <select
            id="share-download-policy"
            className="settings-select"
            value={shareDownloadPolicyInput}
            disabled={sharePermissionInput !== 'download'}
            onChange={(e) => setShareDownloadPolicyInput(e.target.value as ShareDownloadPolicy)}
          >
            <option value="none">No downloads</option>
            <option value="derivative_only">Derivative only</option>
            <option value="original_and_derivative">Original + derivative</option>
          </select>

          <label className="settings-label" htmlFor="share-watermark">
            Watermark derivatives
          </label>
          <input
            id="share-watermark"
            type="checkbox"
            checked={shareWatermarkEnabled}
            disabled={sharePermissionInput !== 'download' || shareDownloadPolicyInput === 'none'}
            onChange={(e) => setShareWatermarkEnabled(e.target.checked)}
          />

          <button className="btn-primary" onClick={handleCreateShareLink}>
            Create share link
          </button>
        </div>

        {shareError && <p className="error">{shareError}</p>}

        {!shareLoading && shareLinks.length > 0 && (
          <p className="album-date" style={{ marginTop: 8 }}>
            {`Active links: ${shareLinks.length - expiredShareLinks.length} • Expired links: ${expiredShareLinks.length}`}
            {expiredShareLinks.length > 0 && (
              <>
                {' '}
                <button className="btn-ghost btn-sm" onClick={() => void revokeExpiredLinks()}>
                  Revoke expired links
                </button>
              </>
            )}
          </p>
        )}

        {shareLoading ? (
          <p className="state-message">Loading links…</p>
        ) : shareLinks.length === 0 ? (
          <p className="state-message">No active share links yet.</p>
        ) : (
          <ul className="album-list">
            {shareLinks.map((link) => (
              <li key={link.id} className="album-item">
                <div>
                  <div className="album-name">Token: {link.token}</div>
                  <div className="album-date">
                    {`Status: ${expiredShareLinkIds.has(link.id) ? 'expired' : 'active'}`}
                    {` • Uses: ${link.useCount}`}
                    {link.policy.expiresAt
                      ? ` • Expires ${new Date(link.policy.expiresAt).toLocaleString()}`
                      : ' • No expiry'}
                    {link.policy.passwordProtected ? ' • Password protected' : ''}
                    {` • Permission: ${link.policy.permission}`}
                    {` • Download: ${link.policy.downloadPolicy}`}
                    {link.policy.watermarkEnabled ? ' • Watermark derivatives' : ''}
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn-ghost btn-sm"
                      onClick={() => void toggleSharePermission(link)}
                    >
                      {link.policy.permission === 'download' ? 'Set view-only' : 'Allow downloads'}
                    </button>
                    <button
                      className="btn-ghost btn-sm"
                      disabled={link.policy.permission !== 'download'}
                      onClick={() => void cycleShareDownloadPolicy(link)}
                    >
                      Cycle download policy
                    </button>
                    <button
                      className="btn-ghost btn-sm"
                      disabled={link.policy.downloadPolicy === 'none'}
                      onClick={() => void toggleShareWatermark(link.id, !link.policy.watermarkEnabled)}
                    >
                      {link.policy.watermarkEnabled ? 'Disable watermark' : 'Enable watermark'}
                    </button>
                    <button
                      className="btn-ghost btn-sm"
                      disabled={!!shareDownloadProbeBusy[`${link.id}:original`]}
                      onClick={() => void probeShareDownload(link, 'original')}
                    >
                      Probe original
                    </button>
                    <button
                      className="btn-ghost btn-sm"
                      disabled={!!shareDownloadProbeBusy[`${link.id}:derivative`]}
                      onClick={() => void probeShareDownload(link, 'derivative')}
                    >
                      Probe derivative
                    </button>
                  </div>
                  {(shareDownloadProbeMessage[`${link.id}:original`] ||
                    shareDownloadProbeMessage[`${link.id}:derivative`]) && (
                    <div className="album-date" style={{ marginTop: 6 }}>
                      {shareDownloadProbeMessage[`${link.id}:original`]
                        ? `Original: ${shareDownloadProbeMessage[`${link.id}:original`]}`
                        : ''}
                      {shareDownloadProbeMessage[`${link.id}:original`] &&
                      shareDownloadProbeMessage[`${link.id}:derivative`]
                        ? ' • '
                        : ''}
                      {shareDownloadProbeMessage[`${link.id}:derivative`]
                        ? `Derivative: ${shareDownloadProbeMessage[`${link.id}:derivative`]}`
                        : ''}
                    </div>
                  )}
                </div>
                <button className="btn-ghost btn-sm" onClick={() => revokeLink(link.id)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}

        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 className="settings-heading" style={{ margin: 0 }}>
              Share access activity
            </h3>
            <button className="btn-ghost btn-sm" onClick={() => void refreshAccessEvents()}>
              Refresh
            </button>
          </div>
          {loadingAccessEvents ? (
            <p className="state-message">Loading access activity…</p>
          ) : accessEventsError ? (
            <p className="error">{accessEventsError}</p>
          ) : shareAccessEvents.length === 0 ? (
            <p className="state-message">No share access attempts yet.</p>
          ) : (
            <>
              <p className="album-date" style={{ marginTop: 8 }}>
                {`Granted: ${grantedShareAccessCount} • Denied: ${deniedShareAccessCount}`}
              </p>
              <ul className="album-list">
                {shareAccessEvents.slice(0, 5).map((event) => (
                  <li key={event.id} className="album-item">
                    <div>
                      <div className="album-name">{event.outcome}</div>
                      <div className="album-date">
                        {`${event.attempt} • ${event.linkId ?? 'unknown-link'}`}
                      </div>
                      <div className="album-date">
                        {new Date(event.occurredAt).toLocaleString()}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>

      <div
        className={`page-with-toolbar${isFilmstrip ? ' page--viewer-mode' : ''}`}
        style={isFilmstrip && viewerState ? { gridTemplateColumns: '1fr auto 68px' } : undefined}
      >
        <div className="page-center-column">
          {libraryLoading ? (
            <p className="state-message">Loading photos…</p>
          ) : albumPhotos.length === 0 ? (
            <div className="empty-state">
              <p>No photos in this album yet.</p>
              <p>
                Use <strong>Add Photos</strong> from the right toolbar.
              </p>
            </div>
          ) : (
            <PhotoGallery
              photos={albumPhotos}
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

        {/* Slide-out panel for viewer tools */}
        {isFilmstrip && (
          <div className={`viewer-slide-panel${viewerState?.activeTool ? ' open' : ''}`}>
            <div className="viewer-slide-panel-header">
              <h3 className="viewer-slide-panel-title">
                {viewerState?.activeTool === 'info' && 'Info'}
                {viewerState?.activeTool === 'versions' && 'Versions'}
                {viewerState?.activeTool === 'comments' && 'Comments'}
                {viewerState?.activeTool === 'tags' && 'Tags'}
                {viewerState?.activeTool === 'presets' && 'Presets'}
                {viewerState?.activeTool === 'edit' && 'Edit'}
                {viewerState?.activeTool === 'crop' && 'Crop'}
              </h3>
              <button
                className="viewer-slide-panel-close"
                onClick={() => viewerState?.setActiveTool(null)}
                title="Close (Esc)"
              >
                ✕
              </button>
            </div>
            <div className="viewer-slide-panel-body">
              {viewerState?.activeTool === 'info' && (
                <>
                  <p className="state-message">Name: {viewerState?.currentPhoto.originalName}</p>
                  <p className="state-message">ID: {viewerState?.currentPhoto.id}</p>
                </>
              )}
              {viewerState?.activeTool === 'versions' && (
                <p className="state-message">Version history tools coming soon.</p>
              )}
              {viewerState?.activeTool === 'comments' && (
                <p className="state-message">Comments tools coming soon.</p>
              )}
              {viewerState?.activeTool === 'tags' && (
                <p className="state-message">Tag management tools coming soon.</p>
              )}
              {viewerState?.activeTool === 'presets' && (
                <p className="state-message">Preset tools coming soon.</p>
              )}
              {viewerState?.activeTool === 'edit' && (
                <>
                  <label className="settings-label" htmlFor="edit-brightness">
                    Brightness
                  </label>
                  <input
                    id="edit-brightness"
                    type="range"
                    min={-100}
                    max={100}
                    value={viewerState?.brightness ?? 0}
                    onChange={(e) => viewerState?.setBrightness(Number(e.target.value))}
                  />
                  <label className="settings-label" htmlFor="edit-contrast">
                    Contrast
                  </label>
                  <input
                    id="edit-contrast"
                    type="range"
                    min={-100}
                    max={100}
                    value={viewerState?.contrast ?? 0}
                    onChange={(e) => viewerState?.setContrast(Number(e.target.value))}
                  />
                  <label className="settings-label" htmlFor="edit-saturation">
                    Saturation
                  </label>
                  <input
                    id="edit-saturation"
                    type="range"
                    min={-100}
                    max={100}
                    value={viewerState?.saturation ?? 0}
                    onChange={(e) => viewerState?.setSaturation(Number(e.target.value))}
                  />
                </>
              )}
              {viewerState?.activeTool === 'crop' && (
                <p className="state-message">Crop tools coming soon.</p>
              )}
            </div>
          </div>
        )}

        <aside className="page-right-column" aria-label="Album tools">
          {isFilmstrip ? (
            viewerState && (
              <>
                <button
                  className="right-toolbar-icon btn-danger-ghost"
                  title="Delete"
                  onClick={() => viewerState.showDeleteConfirm()}
                >
                  🗑
                </button>
                <button
                  className={`right-toolbar-icon btn-ghost${viewerState.activeTool === 'info' ? ' active' : ''}`}
                  title="Info"
                  onClick={() =>
                    viewerState.setActiveTool(viewerState.activeTool === 'info' ? null : 'info')
                  }
                >
                  ℹ
                </button>
                <button
                  className={`right-toolbar-icon btn-ghost${viewerState.activeTool === 'versions' ? ' active' : ''}`}
                  title="Versions"
                  onClick={() =>
                    viewerState.setActiveTool(
                      viewerState.activeTool === 'versions' ? null : 'versions'
                    )
                  }
                >
                  ⧉
                </button>
                <button
                  className={`right-toolbar-icon btn-ghost${viewerState.currentPhoto.isFavorite ? ' active' : ''}`}
                  title={viewerState.currentPhoto.isFavorite ? 'Unfavorite' : 'Favorite'}
                  onClick={() => viewerState.onToggleFavorite()}
                >
                  ♥
                </button>
                <button
                  className={`right-toolbar-icon btn-ghost${viewerState.activeTool === 'comments' ? ' active' : ''}`}
                  title="Comments"
                  onClick={() =>
                    viewerState.setActiveTool(
                      viewerState.activeTool === 'comments' ? null : 'comments'
                    )
                  }
                >
                  💬
                </button>
                <button
                  className={`right-toolbar-icon btn-ghost${viewerState.activeTool === 'tags' ? ' active' : ''}`}
                  title="Tags"
                  onClick={() =>
                    viewerState.setActiveTool(viewerState.activeTool === 'tags' ? null : 'tags')
                  }
                >
                  #
                </button>
                <button
                  className={`right-toolbar-icon btn-ghost${viewerState.activeTool === 'presets' ? ' active' : ''}`}
                  title="Presets"
                  onClick={() =>
                    viewerState.setActiveTool(
                      viewerState.activeTool === 'presets' ? null : 'presets'
                    )
                  }
                >
                  ✶
                </button>
                <button
                  className={`right-toolbar-icon btn-ghost${viewerState.activeTool === 'edit' ? ' active' : ''}`}
                  title="Edit"
                  onClick={() =>
                    viewerState.setActiveTool(viewerState.activeTool === 'edit' ? null : 'edit')
                  }
                >
                  🎚
                </button>
                <button
                  className={`right-toolbar-icon btn-ghost${viewerState.activeTool === 'crop' ? ' active' : ''}`}
                  title="Crop"
                  onClick={() =>
                    viewerState.setActiveTool(viewerState.activeTool === 'crop' ? null : 'crop')
                  }
                >
                  ⬚
                </button>
              </>
            )
          ) : (
            <>
              <button
                className="btn-primary right-toolbar-icon"
                onClick={() => setShowUploadModal(true)}
                title="Add photos"
                aria-label="Add photos"
              >
                +
              </button>
              <button
                className="btn-ghost right-toolbar-icon"
                onClick={async () => {
                  if (selectedPhotoIds.size === 0) return;
                  const selectedPhotos = albumPhotos.filter((p) => selectedPhotoIds.has(p.id));
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
                  if (!confirm(`Delete ${selectedPhotoIds.size} photo(s)?`)) return;
                  const selectedPhotos = albumPhotos.filter((p) => selectedPhotoIds.has(p.id));
                  for (const photo of selectedPhotos) {
                    await deletePhoto(photo.id);
                  }
                  setSelectedPhotoIds(new Set());
                }}
                disabled={selectedPhotoIds.size === 0}
                title="Delete photos"
                aria-label="Delete photos"
              >
                ✕
              </button>
              <button
                className={`btn-ghost right-toolbar-icon${showSettings ? ' active' : ''}`}
                onClick={() => setShowSettings((v) => !v)}
                title="Album settings"
                aria-label="Album settings"
              >
                ⚙
              </button>

              {showSettings && (
                <div className="settings-panel">
                  <h2 className="settings-panel-title">Album Settings</h2>
                  <label className="settings-label" htmlFor="album-name-input">
                    Name
                  </label>
                  <input
                    id="album-name-input"
                    type="text"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                  />

                  <label className="settings-label" htmlFor="album-folder-select">
                    Folder
                  </label>
                  <select
                    id="album-folder-select"
                    className="settings-select"
                    value={folderInput}
                    onChange={(e) => setFolderInput(e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {folders.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}
                      </option>
                    ))}
                  </select>

                  <button
                    className="btn-primary"
                    disabled={saving || !nameInput.trim() || !hasSettingsChanges}
                    onClick={handleSaveSettings}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>

                  <button className="btn-danger-ghost" onClick={handleDeleteAlbum}>
                    Delete Album
                  </button>

                  {albumsError && <p className="error">{albumsError}</p>}
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      {!isFilmstrip && selectedPhotoIds.size > 0 && (
        <div className="floating-selection-toolbar">
          <span className="floating-selection-toolbar-count">{selectedPhotoIds.size} selected</span>
          <div className="floating-selection-toolbar-actions">
            <button
              className="btn-ghost btn-sm"
              onClick={async () => {
                const selectedPhotos = albumPhotos.filter((p) => selectedPhotoIds.has(p.id));
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
              className="btn-ghost btn-sm"
              onClick={async () => {
                if (!confirm(`Remove ${selectedPhotoIds.size} photo(s) from album?`)) return;
                const selectedPhotos = albumPhotos.filter((p) => selectedPhotoIds.has(p.id));
                for (const photo of selectedPhotos) {
                  await removeFromAlbum(photo);
                }
                setSelectedPhotoIds(new Set());
              }}
              title="Remove from album"
            >
              −
            </button>
            <button
              className="btn-danger-ghost btn-sm"
              onClick={async () => {
                if (!confirm(`Delete ${selectedPhotoIds.size} photo(s)?`)) return;
                const selectedPhotos = albumPhotos.filter((p) => selectedPhotoIds.has(p.id));
                for (const photo of selectedPhotos) {
                  await deletePhoto(photo.id);
                }
                setSelectedPhotoIds(new Set());
              }}
              title="Delete photos"
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

      {showUploadModal && albumId && (
        <UploadModal
          preselectedAlbumId={albumId}
          onClose={() => setShowUploadModal(false)}
          onUpload={handleUpload}
        />
      )}
    </>
  );
}
