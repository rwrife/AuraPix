import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAlbums } from '../features/albums/useAlbums';

export function FolderDetailPage() {
  const { folderId } = useParams<{ folderId: string }>();
  const navigate = useNavigate();
  const { folders, albums, loading, error, renameFolder, deleteFolder } = useAlbums();

  const folder = folders.find((f) => f.id === folderId) ?? null;
  const folderAlbums = albums.filter((a) => a.folderId === folderId);

  const [showSettings, setShowSettings] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!folder) return;
    setNameInput(folder.name);
  }, [folder]);

  async function handleSaveSettings() {
    if (!folder || !nameInput.trim()) return;
    if (nameInput.trim() === folder.name) return;

    setSaving(true);
    await renameFolder(folder.id, nameInput.trim());
    setSaving(false);
  }

  async function handleDeleteFolder() {
    if (!folder) return;
    if (
      !confirm(
        `Delete folder "${folder.name}"? Albums will become unassigned and photos will not be deleted.`
      )
    ) {
      return;
    }

    await deleteFolder(folder.id);
    navigate('/albums');
  }

  if (loading) return <p className="state-message">Loading folder…</p>;

  if (!folder) {
    return (
      <div className="page">
        <p className="error">Folder not found.</p>
        <Link to="/albums" className="nav-link">
          ← Back to albums
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="page-titlebar">
        <Link to="/albums" className="btn-ghost btn-sm">
          ← Albums
        </Link>
        <h1 className="page-title">{folder.name}</h1>
      </div>

      <div className="page-with-toolbar">
        <div className="page-center-column">
          {folderAlbums.length === 0 ? (
            <div className="empty-state">
              <p>No albums in this folder.</p>
            </div>
          ) : (
            <ul className="album-list">
              {folderAlbums.map((album) => (
                <li key={album.id} className="album-item">
                  <Link to={`/albums/${album.id}`} className="album-link">
                    <span className="album-name">{album.name}</span>
                  </Link>
                  <span className="album-date">
                    {new Date(album.createdAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="page-right-column" aria-label="Folder tools">
          <button
            className={`btn-ghost right-toolbar-icon${showSettings ? ' active' : ''}`}
            onClick={() => setShowSettings((v) => !v)}
            title="Folder settings"
            aria-label="Folder settings"
          >
            ⚙
          </button>

          {showSettings && (
            <div className="settings-panel">
              <h2 className="settings-panel-title">Folder Settings</h2>
              <label className="settings-label" htmlFor="folder-name-input">
                Name
              </label>
              <input
                id="folder-name-input"
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
              />

              <button
                className="btn-primary"
                disabled={saving || !nameInput.trim() || nameInput.trim() === folder.name}
                onClick={handleSaveSettings}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>

              <button className="btn-danger-ghost" onClick={handleDeleteFolder}>
                Delete Folder
              </button>

              {error && <p className="error">{error}</p>}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
