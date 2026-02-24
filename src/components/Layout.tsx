import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import type { Album, AlbumFolder } from "../domain/albums/types";
import { AlbumsProvider, useAlbums } from "../features/albums/useAlbums";
import { useAuth } from "../features/auth/useAuth";

// ── Inner shell (needs AlbumsProvider above it) ──────────────────────────
function LayoutShell() {
  const { user, signOut } = useAuth();
  const { albums, folders } = useAlbums();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");

  const avatarLetter = (
    user?.displayName ??
    user?.email ??
    "?"
  )[0].toUpperCase();

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    // Full-text search wired in a future phase
  }

  function navClass({ isActive }: { isActive: boolean }) {
    return isActive ? "sidebar-link active" : "sidebar-link";
  }

  // Build folder → albums mapping for sidebar
  const folderAlbums = (folder: AlbumFolder): Album[] =>
    albums.filter((a) => a.folderId === folder.id);
  const ungrouped = albums.filter((a) => !a.folderId);

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <span className="app-logo">AuraPix</span>
        <button
          className="btn-primary topbar-add-btn"
          onClick={() => navigate("/library")}
        >
          + Add Photos
        </button>
        <form className="topbar-search" onSubmit={handleSearch}>
          <span className="topbar-search-icon">🔍</span>
          <input
            type="text"
            placeholder="Search photos…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </form>
        {user && (
          <div className="topbar-user">
            <span className="user-avatar">{avatarLetter}</span>
            <span className="user-name">{user.displayName ?? user.email}</span>
            <button className="btn-ghost btn-sm" onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </header>

      <div className="app-body">
        <nav className="app-sidebar">
          <NavLink to="/recent" className={navClass}>
            <span className="sidebar-icon">🕐</span>
            <span>Recent</span>
          </NavLink>
          <NavLink to="/library" className={navClass} end>
            <span className="sidebar-icon">🖼️</span>
            <span>Library</span>
          </NavLink>
          <NavLink to="/teams" className={navClass}>
            <span className="sidebar-icon">👥</span>
            <span>Teams</span>
          </NavLink>
          <NavLink to="/favorites" className={navClass}>
            <span className="sidebar-icon">❤️</span>
            <span>Favorites</span>
          </NavLink>

          <div className="sidebar-section">
            <NavLink to="/albums" className={navClass} end>
              <span className="sidebar-icon">📁</span>
              <span>Albums</span>
            </NavLink>

            {/* Folders with their albums */}
            {folders.map((folder) => (
              <div key={folder.id} className="sidebar-folder">
                <span className="sidebar-folder-label">
                  <span className="sidebar-icon">📂</span>
                  {folder.name}
                </span>
                {folderAlbums(folder).length > 0 && (
                  <ul className="sidebar-album-list">
                    {folderAlbums(folder).map((album) => (
                      <li key={album.id}>
                        <NavLink
                          to={`/albums/${album.id}`}
                          className={navClass}
                        >
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