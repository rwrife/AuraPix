import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../features/auth/useAuth";

export function Layout() {
  const { user, signOut } = useAuth();

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-logo">AuraPix</span>
        <nav className="app-nav">
          <NavLink to="/library" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>
            Library
          </NavLink>
          <NavLink to="/albums" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>
            Albums
          </NavLink>
        </nav>
        {user && (
          <div className="app-user">
            <span className="user-name">{user.displayName ?? user.email}</span>
            <button className="btn-ghost" onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}