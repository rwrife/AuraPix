import { useState, useMemo } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { AlbumsProvider, useAlbums } from '../features/albums/useAlbums';
import { useAuth } from '../features/auth/useAuth';
import { SidebarNav } from './sidebar';
import type { SidebarItem } from './sidebar';

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
  const [showUserMenu, setShowUserMenu] = useState(false);

  // Determine if we're in local mode based on environment
  const isLocalMode = import.meta.env.VITE_SERVICE_MODE !== 'firebase';

  const avatarLetter = user ? (user.displayName ?? user.email ?? '?')[0].toUpperCase() : '?';
  const displayName = user?.displayName ?? user?.email ?? 'User';

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    // Full-text search wired in a future phase
  }

  function handleSignOut() {
    setShowUserMenu(false);
    signOut();
  }

  // Build sidebar navigation items
  const sidebarTopItems = useMemo<SidebarItem[]>(() => {
    const items: SidebarItem[] = [
      {
        type: 'link',
        id: 'recent',
        label: 'Recent',
        to: '/recent',
        icon: <RecentIcon />,
      },
      {
        type: 'link',
        id: 'library',
        label: 'Library',
        to: '/library',
        icon: <LibraryIcon />,
        end: true,
      },
      {
        type: 'link',
        id: 'teams',
        label: 'Teams',
        to: '/teams',
        icon: <TeamsIcon />,
      },
      {
        type: 'link',
        id: 'favorites',
        label: 'Favorites',
        to: '/favorites',
        icon: <FavoritesIcon />,
      },
    ];

    // Build Albums parent item with children
    const albumChildren = [
      // Folder-grouped albums
      ...folders.flatMap((folder) =>
        albums
          .filter((a) => a.folderId === folder.id)
          .map((album) => ({
            id: album.id,
            label: album.name,
            to: `/albums/${album.id}`,
            groupLabel: folder.name,
          }))
      ),
      // Ungrouped albums
      ...albums
        .filter((a) => !a.folderId)
        .map((album) => ({
          id: album.id,
          label: album.name,
          to: `/albums/${album.id}`,
        })),
    ];

    items.push({
      type: 'parent',
      id: 'albums',
      label: 'Albums',
      to: '/albums',
      icon: <AlbumsIcon />,
      children: albumChildren,
      defaultExpanded: true,
    });

    return items;
  }, [albums, folders]);

  const sidebarBottomItems = useMemo<SidebarItem[]>(() => {
    return [
      {
        type: 'link',
        id: 'settings',
        label: 'Settings',
        to: '/settings',
        icon: (
          <svg viewBox="0 0 24 24" className="sidebar-icon-svg" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v6m0 6v10M1 12h6m6 0h10" />
            <path d="m4.93 4.93 4.24 4.24m5.66 0 4.24-4.24M4.93 19.07l4.24-4.24m5.66 0 4.24 4.24" />
          </svg>
        ),
      },
    ];
  }, []);

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
          <div className="topbar-user">
            <button
              className="user-profile-trigger"
              onClick={() => setShowUserMenu(!showUserMenu)}
              aria-label="User menu"
            >
              <span className="user-avatar">{avatarLetter}</span>
              <span className="user-name">{displayName}</span>
              {isLocalMode && <span className="user-mode-badge">Local</span>}
            </button>

            {showUserMenu && (
              <div className="user-menu-dropdown">
                <div className="user-menu-header">
                  <div className="user-avatar-large">{avatarLetter}</div>
                  <div className="user-info">
                    <div className="user-info-name">{displayName}</div>
                    {user?.email && <div className="user-info-email">{user.email}</div>}
                    {isLocalMode && (
                      <div className="user-info-mode">Single-user mode</div>
                    )}
                  </div>
                </div>

                <div className="user-menu-divider" />

                <div className="user-menu-actions">
                  {!isLocalMode && (
                    <button className="user-menu-item" onClick={handleSignOut}>
                      <svg
                        viewBox="0 0 24 24"
                        className="user-menu-icon"
                        aria-hidden="true"
                      >
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                        <polyline points="16 17 21 12 16 7" />
                        <line x1="21" y1="12" x2="9" y2="12" />
                      </svg>
                      Sign out
                    </button>
                  )}
                  {isLocalMode && (
                    <div className="user-menu-note">
                      Authentication is not available in local mode. When deployed with
                      Firebase, user sign-in and sign-out will be enabled here.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {showUserMenu && (
            <div
              className="user-menu-backdrop"
              onClick={() => setShowUserMenu(false)}
            />
          )}
        </div>
      </header>

      <div className="app-body">
        <SidebarNav topItems={sidebarTopItems} bottomItems={sidebarBottomItems} />

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
