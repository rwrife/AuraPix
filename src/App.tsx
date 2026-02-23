import { FormEvent, useMemo, useState } from 'react';
import { InMemoryAlbumsService } from './adapters/albums/inMemoryAlbumsService';
import { useAlbums } from './features/albums/useAlbums';

export function App() {
  const albumsService = useMemo(() => new InMemoryAlbumsService(), []);
  const { albums, loading, error, createAlbum } = useAlbums(albumsService);
  const [albumName, setAlbumName] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await createAlbum(albumName);
    setAlbumName('');
  }

  return (
    <main className="container">
      <h1>AuraPix</h1>
      <p>Albums vertical slice: create and view albums using a contract-aligned stub service.</p>

      <section className="panel">
        <h2>Create album</h2>
        <form className="album-form" onSubmit={handleSubmit}>
          <label htmlFor="album-name">Album name</label>
          <input
            id="album-name"
            name="albumName"
            value={albumName}
            onChange={(event) => setAlbumName(event.target.value)}
            placeholder="e.g. Weekend Trip"
          />
          <button type="submit">Create album</button>
        </form>
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="panel">
        <h2>Albums</h2>
        {loading ? <p>Loading albums…</p> : null}
        {!loading && albums.length === 0 ? <p>No albums yet.</p> : null}
        {!loading && albums.length > 0 ? (
          <ul className="album-list">
            {albums.map((album) => (
              <li key={album.id}>
                <span>{album.name}</span>
                <time dateTime={album.createdAt}>{new Date(album.createdAt).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
