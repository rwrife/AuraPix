import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { Album, AlbumFolder } from '../domain/albums/types';
import type { Photo } from '../domain/library/types';
import { useAlbums } from '../features/albums/useAlbums';
import { useAuth } from '../features/auth/useAuth';
import { useLibrary } from '../features/library/useLibrary';

function toLibraryId(userId: string) {
  return `library-${userId}`;
}

function NewFolderIcon() {
  return (
    <svg viewBox="0 0 24 24" className="mono-icon-svg" aria-hidden="true">
      <path d="M3 9h6l1.8 2H21v7.3A1.7 1.7 0 0 1 19.3 20H4.7A1.7 1.7 0 0 1 3 18.3V9Z" />
      <path d="M3 9V7A2 2 0 0 1 5 5h4l1.5 2H19a2 2 0 0 1 2 2" />
      <path d="M14.5 14h3" />
      <path d="M16 12.5v3" />
    </svg>
  );
}

// ── Placeholder SVG ──────────────────────────────────────────────────────
function AlbumPlaceholder() {
  return (
    <svg
      viewBox="0 0 120 120"
      xmlns="http://www.w3.org/2000/svg"
      className="album-placeholder-svg"
      aria-hidden="true"
    >
      <rect width="120" height="120" fill="#f1f5f9" />
      <rect x="20" y="38" width="80" height="56" rx="5" fill="#e2e8f0" />
      <circle cx="44" cy="60" r="9" fill="#cbd5e1" />
      <polygon points="28,82 52,56 68,72 82,58 100,82" fill="#cbd5e1" />
      <rect x="30" y="26" width="38" height="7" rx="3.5" fill="#e2e8f0" />
    </svg>
  );
}

// ── Photo collage ────────────────────────────────────────────────────────
function AlbumCollage({ albumPhotos }: { albumPhotos: Photo[] }) {
  const tiles = albumPhotos.slice(0, 4);
  if (tiles.length === 0) return <AlbumPlaceholder />;
  return (
    <div className={`album-collage album-collage-${tiles.length}`}>
      {tiles.map((photo) => (
        <img
          key={photo.id}
          src={photo.thumbnailPath ?? photo.storagePath}
          alt={photo.originalName}
          className="collage-img"
          loading="lazy"
        />
      ))}
    </div>
  );
}

// ── Album grid card ──────────────────────────────────────────────────────
interface AlbumGridCardProps {
  album: Album;
  albumPhotos: Photo[];
  folders: AlbumFolder[];
  onRename(albumId: string, currentName: string): void;
  onDelete(albumId: string, albumName: string): void;
  onMove(albumId: string, folderId: string | null): void;
  deleting: boolean;
}

function AlbumGridCard({
  album,
  albumPhotos,
  folders,
  onRename,
  onDelete,
  onMove,
  deleting,
}: AlbumGridCardProps) {
  return (
    <div className="album-grid-card">
      <Link to={`/albums/${album.id}`} className="album-collage-link">
        <AlbumCollage albumPhotos={albumPhotos} />
      </Link>
      <div className="album-grid-card-footer">
        <div className="album-grid-card-info">
          <Link to={`/albums/${album.id}`} className="album-link">
            {album.name}
          </Link>
          <span className="album-photo-count">
            {albumPhotos.length} photo{albumPhotos.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="album-card-actions">
          <button
            className="btn-ghost btn-sm"
            onClick={() => onRename(album.id, album.name)}
            title="Rename album"
          >
            Rename
          </button>
          <select
            className="folder-select"
            value={album.folderId ?? ''}
            onChange={(e) => onMove(album.id, e.target.value === '' ? null : e.target.value)}
            title="Move to folder"
          >
            <option value="">No folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <button
            className="btn-ghost btn-sm"
            disabled={deleting}
            onClick={() => onDelete(album.id, album.name)}
            title="Delete album"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Album list row ───────────────────────────────────────────────────────
interface AlbumListRowProps {
  album: Album;
  albumPhotos: Photo[];
  folders: AlbumFolder[];
  onRename(albumId: string, currentName: string): void;
  onDelete(albumId: string, albumName: string): void;
  onMove(albumId: string, folderId: string | null): void;
  deleting: boolean;
}

function AlbumListRow({
  album,
  albumPhotos,
  folders,
  onRename,
  onDelete,
  onMove,
  deleting,
}: AlbumListRowProps) {
  return (
    <li className="album-item">
      <Link to={`/albums/${album.id}`} className="album-link">
        <span className="album-name">{album.name}</span>
        <span className="album-date">{new Date(album.createdAt).toLocaleDateString()}</span>
        <span className="album-photo-count">
          {albumPhotos.length} photo{albumPhotos.length !== 1 ? 's' : ''}
        </span>
      </Link>
      <div className="album-item-actions">
        <button className="btn-ghost btn-sm" onClick={() => onRename(album.id, album.name)}>
          Rename
        </button>
        <select
          className="folder-select"
          value={album.folderId ?? ''}
          onChange={(e) => onMove(album.id, e.target.value === '' ? null : e.target.value)}
          title="Move to folder"
        >
          <option value="">No folder</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <button
          className="btn-ghost btn-sm"
          disabled={deleting}
          onClick={() => onDelete(album.id, album.name)}
          title="Delete album"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

// ── Folder section ────────────────────────────────────────────────────────
interface FolderSectionProps {
  folder: AlbumFolder | null; // null = ungrouped
  folderAlbums: Album[];
  allPhotos: Photo[];
  allFolders: AlbumFolder[];
  viewMode: 'grid' | 'list';
  deletingId: string | null;
  onRename(albumId: string, currentName: string): void;
  onDelete(albumId: string, albumName: string): void;
  onMove(albumId: string, folderId: string | null): void;
  onDeleteFolder?(folderId: string, folderName: string): void;
}

function FolderSection({
  folder,
  folderAlbums,
  allPhotos,
  allFolders,
  viewMode,
  deletingId,
  onRename,
  onDelete,
  onMove,
  onDeleteFolder,
}: FolderSectionProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (folderAlbums.length === 0 && folder !== null) return null;

  const photosForAlbum = (albumId: string) => allPhotos.filter((p) => p.albumIds.includes(albumId));

  return (
    <div className="folder-section">
      <div className="folder-section-header">
        <button
          className="folder-collapse-btn"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▶' : '▼'}
        </button>
        {folder ? (
          <>
            <span className="folder-section-icon">📂</span>
            <Link
              to={`/albums/folders/${folder.id}`}
              className="folder-section-name folder-section-link"
            >
              {folder.name}
            </Link>
            <span className="folder-album-count">
              {folderAlbums.length} album{folderAlbums.length !== 1 ? 's' : ''}
            </span>
            {onDeleteFolder && (
              <button
                className="btn-ghost btn-sm folder-delete-btn"
                onClick={() => onDeleteFolder(folder.id, folder.name)}
                title="Delete folder (albums will become ungrouped)"
              >
                Delete folder
              </button>
            )}
          </>
        ) : (
          <>
            <span className="folder-section-icon">📄</span>
            <span className="folder-section-name folder-section-name--ungrouped">Ungrouped</span>
            <span className="folder-album-count">
              {folderAlbums.length} album{folderAlbums.length !== 1 ? 's' : ''}
            </span>
          </>
        )}
      </div>

      {!collapsed &&
        (viewMode === 'grid' ? (
          <div className="album-grid-view">
            {folderAlbums.map((album) => (
              <AlbumGridCard
                key={album.id}
                album={album}
                albumPhotos={photosForAlbum(album.id)}
                folders={allFolders}
                onRename={onRename}
                onDelete={onDelete}
                onMove={onMove}
                deleting={deletingId === album.id}
              />
            ))}
          </div>
        ) : (
          <ul className="album-list">
            {folderAlbums.map((album) => (
              <AlbumListRow
                key={album.id}
                album={album}
                albumPhotos={photosForAlbum(album.id)}
                folders={allFolders}
                onRename={onRename}
                onDelete={onDelete}
                onMove={onMove}
                deleting={deletingId === album.id}
              />
            ))}
          </ul>
        ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────
export function AlbumsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const libraryId = toLibraryId(user?.id ?? 'local-user-1');
  const {
    albums,
    folders,
    loading,
    error,
    createAlbum,
    renameAlbum,
    deleteAlbum,
    createFolder,
    deleteFolder,
    moveAlbum,
    reload,
  } = useAlbums();
  const { photos } = useLibrary(libraryId);

  const [albumName, setAlbumName] = useState('');
  const [albumFolderId, setAlbumFolderId] = useState('');
  const [albumFormError, setAlbumFormError] = useState<string | null>(null);
  const [creatingCount, setCreatingCount] = useState(0);
  const [folderName, setFolderName] = useState('');
  const [showFolderForm, setShowFolderForm] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [createdAlbumId, setCreatedAlbumId] = useState<string | null>(null);
  const initialFilters = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return {
      q: params.get('q')?.trim() ?? '',
      sort: (params.get('sort') as 'newest' | 'oldest' | 'name-asc' | 'name-desc' | null) ?? 'newest',
      page: Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1),
    };
  }, [location.search]);

  const [searchQuery, setSearchQuery] = useState(initialFilters.q);
  const [sortMode, setSortMode] = useState<'newest' | 'oldest' | 'name-asc' | 'name-desc'>(initialFilters.sort);
  const [page, setPage] = useState(initialFilters.page);
  const pageSize = 12;

  useEffect(() => {
    setSearchQuery(initialFilters.q);
    setSortMode(initialFilters.sort);
    setPage(initialFilters.page);
  }, [initialFilters]);

  const visibleAlbums = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? albums.filter((album) => album.name.toLowerCase().includes(query))
      : albums;

    return [...filtered].sort((a, b) => {
      if (sortMode === 'name-asc') return a.name.localeCompare(b.name);
      if (sortMode === 'name-desc') return b.name.localeCompare(a.name);
      if (sortMode === 'oldest') return a.createdAt.localeCompare(b.createdAt);
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [albums, searchQuery, sortMode]);

  const totalPages = Math.max(1, Math.ceil(visibleAlbums.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedAlbums = visibleAlbums.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, sortMode]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (searchQuery.trim()) params.set('q', searchQuery.trim());
    else params.delete('q');
    if (sortMode !== 'newest') params.set('sort', sortMode);
    else params.delete('sort');
    if (currentPage > 1) params.set('page', String(currentPage));
    else params.delete('page');

    const nextSearch = params.toString();
    if (nextSearch !== location.search.replace(/^\?/, '')) {
      navigate({ pathname: location.pathname, search: nextSearch ? `?${nextSearch}` : '' }, { replace: true });
    }
  }, [currentPage, location.pathname, location.search, navigate, searchQuery, sortMode]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  async function handleCreateAlbum(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = albumName.trim();
    if (!trimmedName) {
      setAlbumFormError('Album name is required.');
      return;
    }

    const selectedFolderId = albumFolderId || null;

    setAlbumFormError(null);
    setAlbumName('');
    setAlbumFolderId('');
    setCreatingCount((count) => count + 1);

    try {
      const created = await createAlbum(trimmedName, selectedFolderId);
      if (!created) {
        setAlbumName(trimmedName);
        setAlbumFolderId(selectedFolderId ?? '');
        return;
      }

      setCreatedAlbumId(created.id);
    } finally {
      setCreatingCount((count) => Math.max(0, count - 1));
    }
  }

  async function handleCreateFolder(e: React.FormEvent) {
    e.preventDefault();
    if (!folderName.trim()) return;
    setCreatingFolder(true);
    await createFolder(folderName.trim());
    setFolderName('');
    setCreatingFolder(false);
    setShowFolderForm(false);
  }

  async function handleDeleteAlbum(albumId: string, albumName: string) {
    if (!confirm(`Delete album "${albumName}"? Photos will not be deleted.`)) return;
    setDeletingId(albumId);
    await deleteAlbum(albumId);
    setDeletingId(null);
  }

  async function handleRenameAlbum(albumId: string, currentName: string) {
    const nextName = prompt('Rename album', currentName)?.trim();
    if (!nextName || nextName === currentName) return;
    await renameAlbum(albumId, nextName);
  }

  async function handleDeleteFolder(folderId: string, name: string) {
    if (!confirm(`Delete folder "${name}"? Albums inside will become ungrouped.`)) return;
    await deleteFolder(folderId);
  }

  return (
    <>
      <div className="page-titlebar">
        <h1 className="page-title">Albums</h1>
        <div className="header-actions">
          <button className="btn-ghost btn-sm" onClick={() => setShowFolderForm((v) => !v)}>
            <span className="btn-inline-icon" aria-hidden="true">
              <NewFolderIcon />
            </span>
            New Folder
          </button>
          <button
            className={`btn-ghost btn-sm${viewMode === 'grid' ? ' active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Grid view"
          >
            ⊞ Grid
          </button>
          <button
            className={`btn-ghost btn-sm${viewMode === 'list' ? ' active' : ''}`}
            onClick={() => setViewMode('list')}
            title="List view"
          >
            ≡ List
          </button>
        </div>
      </div>

      <div className="page-content">
        {/* Create folder form */}
        {showFolderForm && (
          <form className="album-form" onSubmit={handleCreateFolder}>
            <input
              type="text"
              placeholder="Folder name"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              disabled={creatingFolder}
              autoFocus
            />
            <button type="submit" disabled={creatingFolder || !folderName.trim()}>
              {creatingFolder ? 'Creating…' : 'Create folder'}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setShowFolderForm(false)}>
              Cancel
            </button>
          </form>
        )}

        {/* Create album form */}
        <form className="album-form" onSubmit={handleCreateAlbum}>
          <input
            type="text"
            placeholder="New album name"
            value={albumName}
            onChange={(e) => {
              setAlbumName(e.target.value);
              if (albumFormError) setAlbumFormError(null);
            }}
          />
          <select
            value={albumFolderId}
            onChange={(e) => setAlbumFolderId(e.target.value)}
            aria-label="Album folder"
            title="Place album in a folder"
          >
            <option value="">No folder</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
          <button type="submit" disabled={!albumName.trim()}>
            {creatingCount > 0 ? `Create album (${creatingCount} pending)` : 'Create album'}
          </button>
        </form>

        {albumFormError && <p className="error">{albumFormError}</p>}

        {createdAlbumId && (
          <p className="state-message" role="status">
            Album created. <Link to={`/albums/${createdAlbumId}`}>Open it now</Link>
          </p>
        )}

        <div className="album-form" role="group" aria-label="Album list controls">
          <input
            type="search"
            placeholder="Search albums"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search albums"
          />
          <select
            value={sortMode}
            onChange={(e) =>
              setSortMode(e.target.value as 'newest' | 'oldest' | 'name-asc' | 'name-desc')
            }
            aria-label="Sort albums"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name-asc">Name (A-Z)</option>
            <option value="name-desc">Name (Z-A)</option>
          </select>
        </div>

        {visibleAlbums.length > 0 && (
          <div className="page-pagination" aria-label="Album pagination">
            <button
              className="btn-ghost btn-sm"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={currentPage <= 1}
            >
              Previous
            </button>
            <span className="pagination-summary">
              Page {currentPage} of {totalPages}
            </span>
            <button
              className="btn-ghost btn-sm"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={currentPage >= totalPages}
            >
              Next
            </button>
          </div>
        )}

        {error && (
          <div className="error" role="alert">
            <span>{error}</span>{' '}
            <button type="button" className="btn-ghost btn-sm" onClick={() => void reload()}>
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <p className="state-message">Loading albums…</p>
        ) : visibleAlbums.length === 0 ? (
          <p className="state-message">No albums yet. Create one above.</p>
        ) : (
          <div className="folders-container">
            {/* Folder sections */}
            {folders.map((folder) => (
              <FolderSection
                key={folder.id}
                folder={folder}
                folderAlbums={pagedAlbums.filter((a) => a.folderId === folder.id)}
                allPhotos={photos}
                allFolders={folders}
                viewMode={viewMode}
                deletingId={deletingId}
                onRename={handleRenameAlbum}
                onDelete={handleDeleteAlbum}
                onMove={moveAlbum}
                onDeleteFolder={handleDeleteFolder}
              />
            ))}

            {/* Ungrouped albums */}
            {pagedAlbums.filter((a) => !a.folderId).length > 0 && (
              <FolderSection
                folder={null}
                folderAlbums={pagedAlbums.filter((a) => !a.folderId)}
                allPhotos={photos}
                allFolders={folders}
                viewMode={viewMode}
                deletingId={deletingId}
                onRename={handleRenameAlbum}
                onDelete={handleDeleteAlbum}
                onMove={moveAlbum}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}
