import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import type { Album, AlbumFolder } from '../domain/albums/types';
import { AlbumsProvider, useAlbums } from '../features/albums/useAlbums';
import { useAuth } from '../features/auth/useAuth';

function RecentIcon() {
  return (
    <svg viewBox="0 0 24 24" className="sidebar-icon-svg" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg viewBox="0 0 24 24" className="sidebar-icon-svg" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m6.5 16 4-4 2.5 2.5 2.5-2.5 2 2" />
    </svg>
  );
}

function TeamsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="sidebar-icon-svg" aria-hidden="true">
      <circle cx="9" cy="9" r="2.5" />
      <circle cx="15.5" cy="10" r="2" />
      <path d="M4.5 17c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4" />
      <path d="M13 17c.2-1.6 1.6-2.9 3.5-2.9 1.6 0 2.9.9 3.5 2.1" />
    </svg>
  );
}

function FavoritesIcon() {
  return (
    <svg viewBox="0 0 24 24" className="sidebar-icon-svg" aria-hidden="true">
      <path d="M12 19s-6.5-3.8-8.4-7.5A4.8 4.8 0 0 1 12 6a4.8 4.8 0 0 1 8.4 5.5C18.5 15.2 12 19 12 19Z" />
    </svg>
  );
}

function AlbumsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="sidebar-icon-svg" aria-hidden="true">
      <path d="M3 8.5h7l1.5 1.8H21v8.2a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 18.5V8.5Z" />
      <path d="M3 8.5V6.8A1.8 1.8 0 0 1 4.8 5h4.4l1.4 1.8H19.2A1.8 1.8 0 0 1 21 8.6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" className="sidebar-icon-svg" aria-hidden="true">
      <path d="M3 9h6l1.8 2H21v7.3A1.7 1.7 0 0 1 19.3 20H4.7A1.7 1.7 0 0 1 3 18.3V9Z" />
      <path d="M3 9V7A2 2 0 0 1 5 5h4l1.5 2H19a2 2 0 0 1 2 2" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="topbar-search-icon-svg" aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

// ── Inner shell (needs AlbumsProvider above it) ──────────────────────────
function LayoutShell() {
  const { user, signOut } = useAuth();
  const { albums, folders } = useAlbums();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');

  const avatarLetter = (user?.displayName ?? user?.email ?? '?')[0].toUpperCase();

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    // Full-text search wired in a future phase
  }

  function navClass({ isActive }: { isActive: boolean }) {
    return isActive ? 'sidebar-link active' : 'sidebar-link';
  }

  // Build folder → albums mapping for sidebar
  const folderAlbums = (folder: AlbumFolder): Album[] =>
    albums.filter((a) => a.folderId === folder.id);
  const ungrouped = albums.filter((a) => !a.folderId);

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="topbar-left">
          <span className="app-logo">AuraPix</span>
          <button
            className="btn-primary topbar-add-btn"
            onClick={() => navigate('/library?upload=1')}
          >
            + Add Photos
          </button>
        </div>

        <form className="topbar-search" onSubmit={handleSearch}>
          <span className="topbar-search-icon" aria-hidden="true">
            <SearchIcon />
          </span>
          <input
            type="text"
            placeholder="Search photos…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </form>

        <div className="topbar-right">
          {user && (
            <div className="topbar-user">
              <span className="user-avatar">{avatarLetter}</span>
              <span className="user-name">{user.displayName ?? user.email}</span>
              <button className="btn-ghost btn-sm" onClick={signOut}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="app-body">
        <nav className="app-sidebar">
          <NavLink to="/recent" className={navClass}>
            <span className="sidebar-icon">
              <RecentIcon />
            </span>
            <span>Recent</span>
          </NavLink>
          <NavLink to="/library" className={navClass} end>
            <span className="sidebar-icon">
              <LibraryIcon />
            </span>
            <span>Library</span>
          </NavLink>
          <NavLink to="/teams" className={navClass}>
            <span className="sidebar-icon">
              <TeamsIcon />
            </span>
            <span>Teams</span>
          </NavLink>
          <NavLink to="/favorites" className={navClass}>
            <span className="sidebar-icon">
              <FavoritesIcon />
            </span>
            <span>Favorites</span>
          </NavLink>

          <div className="sidebar-section">
            <NavLink to="/albums" className={navClass} end>
              <span className="sidebar-icon">
                <AlbumsIcon />
              </span>
              <span>Albums</span>
            </NavLink>

            {/* Folders with their albums */}
            {folders.map((folder) => (
              <div key={folder.id} className="sidebar-folder">
                <span className="sidebar-folder-label">
                  <span className="sidebar-icon">
                    <FolderIcon />
                  </span>
                  {folder.name}
                </span>
                {folderAlbums(folder).length > 0 && (
                  <ul className="sidebar-album-list">
                    {folderAlbums(folder).map((album) => (
                      <li key={album.id}>
                        <NavLink to={`/albums/${album.id}`} className={navClass}>
                          {album.name}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}

            {/* Ungrouped albums */}
            {ungrouped.length > 0 && (
              <ul className="sidebar-album-list">
                {ungrouped.map((album) => (
                  <li key={album.id}>
                    <NavLink to={`/albums/${album.id}`} className={navClass}>
                      {album.name}
                    </NavLink>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </nav>

        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

// ── Public Layout (provides AlbumsProvider to child routes) ──────────────
export function Layout() {
  return (
    <AlbumsProvider>
      <LayoutShell />
    </AlbumsProvider>
  );
}
