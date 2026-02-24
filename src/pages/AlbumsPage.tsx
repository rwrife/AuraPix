import { useState } from "react";
import { useAlbums } from "../features/albums/useAlbums";

export function AlbumsPage() {
  const { albums, loading, error, createAlbum } = useAlbums();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    await createAlbum(name.trim());
    setName("");
    setCreating(false);
  }

  return (
    <div className="page">
      <h1 className="page-title">Albums</h1>

      <form className="album-form" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="New album name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={creating}
        />
        <button type="submit" disabled={creating || !name.trim()}>
          {creating ? "Creating…" : "Create album"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="state-message">Loading albums…</p>
      ) : albums.length === 0 ? (
        <p className="state-message">No albums yet. Create one above.</p>
      ) : (
        <ul className="album-list">
          {albums.map((album) => (
            <li key={album.id} className="album-item">
              <span className="album-name">{album.name}</span>
              <span className="album-date">
                {new Date(album.createdAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}