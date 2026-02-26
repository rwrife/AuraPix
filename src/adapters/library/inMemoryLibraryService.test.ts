import { InMemoryLibraryService } from './inMemoryLibraryService';

const LIBRARY_ID = 'library-local-user-1';

describe('InMemoryLibraryService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts with an empty library', async () => {
    const svc = new InMemoryLibraryService();
    const { photos } = await svc.listPhotos({ libraryId: LIBRARY_ID });
    expect(photos).toHaveLength(0);
  });

  it('adds a photo and returns it', async () => {
    const svc = new InMemoryLibraryService();
    const photo = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'sunset.jpg',
      dataUrl: 'data:image/jpeg;base64,abc',
    });
    expect(photo.id).toMatch(/^photo-/);
    expect(photo.originalName).toBe('sunset.jpg');
    expect(photo.status).toBe('ready');

    const { photos } = await svc.listPhotos({ libraryId: LIBRARY_ID });
    expect(photos).toHaveLength(1);
  });

  it('persists photos across service instances via localStorage', async () => {
    const svc1 = new InMemoryLibraryService();
    await svc1.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'persisted.jpg',
      dataUrl: 'data:image/jpeg;base64,xyz',
    });

    const svc2 = new InMemoryLibraryService();
    const { photos } = await svc2.listPhotos({ libraryId: LIBRARY_ID });
    expect(photos.some((p) => p.originalName === 'persisted.jpg')).toBe(true);
  });

  it('toggles isFavorite via updatePhoto', async () => {
    const svc = new InMemoryLibraryService();
    const photo = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'fave.jpg',
      dataUrl: 'data:image/jpeg;base64,fave',
    });
    expect(photo.isFavorite).toBe(false);

    const updated = await svc.updatePhoto(photo.id, { isFavorite: true });
    expect(updated.isFavorite).toBe(true);
  });

  it('filters by albumId', async () => {
    const svc = new InMemoryLibraryService();
    const p1 = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'a.jpg',
      dataUrl: 'data:image/jpeg;base64,a',
    });
    const p2 = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'b.jpg',
      dataUrl: 'data:image/jpeg;base64,b',
    });

    await svc.updatePhoto(p1.id, { albumIds: ['album-1'] });

    const { photos } = await svc.listPhotos({ libraryId: LIBRARY_ID, albumId: 'album-1' });
    expect(photos.map((p) => p.id)).toContain(p1.id);
    expect(photos.map((p) => p.id)).not.toContain(p2.id);
  });

  it('filters by normalized metadata camera make', async () => {
    const svc = new InMemoryLibraryService();
    const canon = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'canon.jpg',
      dataUrl: 'data:image/jpeg;base64,canon',
      metadata: { cameraMake: 'Canon', takenAt: '2026-02-21T10:00:00.000Z' },
    });
    await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'nikon.jpg',
      dataUrl: 'data:image/jpeg;base64,nikon',
      metadata: { cameraMake: 'Nikon', takenAt: '2026-02-21T10:00:00.000Z' },
    });

    const { photos } = await svc.listPhotos({
      libraryId: LIBRARY_ID,
      metadata: { cameraMake: 'canon' },
    });

    expect(photos).toHaveLength(1);
    expect(photos[0].id).toBe(canon.id);
  });

  it('filters by capture datetime bounds', async () => {
    const svc = new InMemoryLibraryService();
    await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'older.jpg',
      dataUrl: 'data:image/jpeg;base64,old',
      metadata: { takenAt: '2026-02-20T10:00:00.000Z' },
    });
    const newer = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'newer.jpg',
      dataUrl: 'data:image/jpeg;base64,new',
      metadata: { takenAt: '2026-02-24T10:00:00.000Z' },
    });

    const { photos } = await svc.listPhotos({
      libraryId: LIBRARY_ID,
      metadata: { takenAfter: '2026-02-22T00:00:00.000Z' },
    });

    expect(photos).toHaveLength(1);
    expect(photos[0].id).toBe(newer.id);
  });

  it('supports quick collection filters for untagged and favorites', async () => {
    const svc = new InMemoryLibraryService();

    const untaggedFavorite = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'untagged-favorite.jpg',
      dataUrl: 'data:image/jpeg;base64,uf',
    });

    const tagged = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'tagged.jpg',
      dataUrl: 'data:image/jpeg;base64,t',
    });

    await svc.updatePhoto(untaggedFavorite.id, { isFavorite: true });
    await svc.updatePhoto(tagged.id, { tags: ['trip'] });

    const untagged = await svc.listPhotos({ libraryId: LIBRARY_ID, collection: 'untagged' });
    expect(untagged.photos.map((photo) => photo.id)).toEqual([untaggedFavorite.id]);

    const favorites = await svc.listPhotos({ libraryId: LIBRARY_ID, collection: 'favorites' });
    expect(favorites.photos.map((photo) => photo.id)).toEqual([untaggedFavorite.id]);
  });

  it('paginates results using nextPageToken', async () => {
    const svc = new InMemoryLibraryService();

    const oldest = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'oldest.jpg',
      dataUrl: 'data:image/jpeg;base64,oldest',
    });
    const middle = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'middle.jpg',
      dataUrl: 'data:image/jpeg;base64,middle',
    });
    const newest = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'newest.jpg',
      dataUrl: 'data:image/jpeg;base64,newest',
    });

    const firstPage = await svc.listPhotos({ libraryId: LIBRARY_ID, pageSize: 2 });
    expect(firstPage.photos.map((photo) => photo.id)).toEqual([newest.id, middle.id]);
    expect(firstPage.nextPageToken).toBe(oldest.id);

    const secondPage = await svc.listPhotos({
      libraryId: LIBRARY_ID,
      pageSize: 2,
      pageToken: firstPage.nextPageToken ?? undefined,
    });
    expect(secondPage.photos.map((photo) => photo.id)).toEqual([oldest.id]);
    expect(secondPage.nextPageToken).toBeNull();
  });

  it('falls back to first page when pageToken is unknown', async () => {
    const svc = new InMemoryLibraryService();

    await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'one.jpg',
      dataUrl: 'data:image/jpeg;base64,one',
    });
    const two = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'two.jpg',
      dataUrl: 'data:image/jpeg;base64,two',
    });

    const page = await svc.listPhotos({
      libraryId: LIBRARY_ID,
      pageSize: 1,
      pageToken: 'not-a-real-photo-id',
    });

    expect(page.photos).toHaveLength(1);
    expect(page.photos[0].id).toBe(two.id);
  });

  it('rejects uploads that exceed configured library quota', async () => {
    const svc = new InMemoryLibraryService({
      quotaBytesByLibraryId: {
        [LIBRARY_ID]: 1024,
      },
    });

    await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'within-limit.jpg',
      dataUrl: 'data:image/jpeg;base64,a',
      metadata: { sizeBytes: 800 },
    });

    await expect(
      svc.addPhoto({
        libraryId: LIBRARY_ID,
        originalName: 'over-limit.jpg',
        dataUrl: 'data:image/jpeg;base64,b',
        metadata: { sizeBytes: 500 },
      })
    ).rejects.toThrow('Storage quota exceeded');
  });

  it('deletes a photo', async () => {
    const svc = new InMemoryLibraryService();
    const photo = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'delete-me.jpg',
      dataUrl: 'data:image/jpeg;base64,del',
    });
    await svc.deletePhoto(photo.id);

    const { photos } = await svc.listPhotos({ libraryId: LIBRARY_ID });
    expect(photos.find((p) => p.id === photo.id)).toBeUndefined();
  });

  it('throws when updating a non-existent photo', async () => {
    const svc = new InMemoryLibraryService();
    await expect(svc.updatePhoto('ghost-id', { isFavorite: true })).rejects.toThrow('not found');
  });

  it('bulkAddToAlbum returns deterministic per-item outcomes', async () => {
    const svc = new InMemoryLibraryService();
    const p1 = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'one.jpg',
      dataUrl: 'data:image/jpeg;base64,one',
    });
    const p2 = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'two.jpg',
      dataUrl: 'data:image/jpeg;base64,two',
    });

    await svc.updatePhoto(p2.id, { albumIds: ['album-a'] });

    const result = await svc.bulkAddToAlbum({
      libraryId: LIBRARY_ID,
      albumId: 'album-a',
      photoIds: [p1.id, p2.id, 'ghost-id'],
    });

    expect(result.results).toEqual([
      { photoId: p1.id, status: 'added' },
      { photoId: p2.id, status: 'skipped', code: 'already_in_album' },
      { photoId: 'ghost-id', status: 'skipped', code: 'not_found' },
    ]);

    const updated = await svc.getPhoto(p1.id);
    expect(updated?.albumIds).toContain('album-a');
  });
});
