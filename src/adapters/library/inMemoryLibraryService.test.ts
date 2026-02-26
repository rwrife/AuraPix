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
});
