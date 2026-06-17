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

  it('supports quick collection filters for favorites/tagged/untagged', async () => {
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

    const taggedCollection = await svc.listPhotos({ libraryId: LIBRARY_ID, collection: 'tagged' });
    expect(taggedCollection.photos.map((photo) => photo.id)).toEqual([tagged.id]);

    const untagged = await svc.listPhotos({ libraryId: LIBRARY_ID, collection: 'untagged' });
    expect(untagged.photos.map((photo) => photo.id)).toEqual([untaggedFavorite.id]);

    const favorites = await svc.listPhotos({ libraryId: LIBRARY_ID, collection: 'favorites' });
    expect(favorites.photos.map((photo) => photo.id)).toEqual([untaggedFavorite.id]);
  });

  it('supports explicit sort conventions', async () => {
    const svc = new InMemoryLibraryService();

    await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'bravo.jpg',
      dataUrl: 'data:image/jpeg;base64,b',
    });
    await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'alpha.jpg',
      dataUrl: 'data:image/jpeg;base64,a',
    });

    const byNameAsc = await svc.listPhotos({ libraryId: LIBRARY_ID, sort: 'name_asc' });
    expect(byNameAsc.photos.map((photo) => photo.originalName)).toEqual(['alpha.jpg', 'bravo.jpg']);

    const byNameDesc = await svc.listPhotos({ libraryId: LIBRARY_ID, sort: 'name_desc' });
    expect(byNameDesc.photos.map((photo) => photo.originalName)).toEqual(['bravo.jpg', 'alpha.jpg']);

    const byCreatedAsc = await svc.listPhotos({ libraryId: LIBRARY_ID, sort: 'created_asc' });
    expect(byCreatedAsc.photos).toHaveLength(2);
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

  it('reports usage summary for telemetry foundations', async () => {
    const svc = new InMemoryLibraryService();
    const favorite = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'favorite.jpg',
      dataUrl: 'data:image/jpeg;base64,favorite',
      metadata: { sizeBytes: 1200 },
    });
    const tagged = await svc.addPhoto({
      libraryId: LIBRARY_ID,
      originalName: 'tagged.jpg',
      dataUrl: 'data:image/jpeg;base64,tagged',
      metadata: { sizeBytes: 800 },
    });

    await svc.updatePhoto(favorite.id, { isFavorite: true });
    await svc.updatePhoto(tagged.id, { tags: ['trip'] });

    const usage = await svc.getUsage(LIBRARY_ID);
    expect(usage).toMatchObject({
      libraryId: LIBRARY_ID,
      totalPhotos: 2,
      readyPhotos: 2,
      favoritePhotos: 1,
      taggedPhotos: 1,
      totalBytes: 2000,
    });
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

  describe('triage (rating + flag)', () => {
    it('defaults new photos to rating=0 and flag=null', async () => {
      const svc = new InMemoryLibraryService();
      const photo = await svc.addPhoto({
        libraryId: LIBRARY_ID,
        originalName: 'fresh.jpg',
        dataUrl: 'data:image/jpeg;base64,fresh',
      });

      expect(photo.rating).toBe(0);
      expect(photo.flag).toBeNull();
    });

    it('updates rating and flag through updatePhoto', async () => {
      const svc = new InMemoryLibraryService();
      const photo = await svc.addPhoto({
        libraryId: LIBRARY_ID,
        originalName: 'pickme.jpg',
        dataUrl: 'data:image/jpeg;base64,pickme',
      });

      const rated = await svc.updatePhoto(photo.id, { rating: 4 });
      expect(rated.rating).toBe(4);

      const flagged = await svc.updatePhoto(photo.id, { flag: 'pick' });
      expect(flagged.flag).toBe('pick');

      const cleared = await svc.updatePhoto(photo.id, { flag: null });
      expect(cleared.flag).toBeNull();
    });

    it('rejects out-of-range ratings (domain rule)', async () => {
      const svc = new InMemoryLibraryService();
      const photo = await svc.addPhoto({
        libraryId: LIBRARY_ID,
        originalName: 'bad.jpg',
        dataUrl: 'data:image/jpeg;base64,bad',
      });

      await expect(
        svc.updatePhoto(photo.id, { rating: 6 as unknown as 0 })
      ).rejects.toThrow(/Invalid rating/);
      await expect(
        svc.updatePhoto(photo.id, { rating: -1 as unknown as 0 })
      ).rejects.toThrow(/Invalid rating/);
      await expect(
        svc.updatePhoto(photo.id, { rating: 2.5 as unknown as 0 })
      ).rejects.toThrow(/Invalid rating/);
    });

    it('rejects invalid flag values', async () => {
      const svc = new InMemoryLibraryService();
      const photo = await svc.addPhoto({
        libraryId: LIBRARY_ID,
        originalName: 'bad-flag.jpg',
        dataUrl: 'data:image/jpeg;base64,badflag',
      });

      await expect(
        svc.updatePhoto(photo.id, { flag: 'maybe' as unknown as 'pick' })
      ).rejects.toThrow(/Invalid flag/);
    });

    it('filters by minRating with pagination preserved', async () => {
      const svc = new InMemoryLibraryService();
      const a = await svc.addPhoto({
        libraryId: LIBRARY_ID,
        originalName: 'a.jpg',
        dataUrl: 'data:image/jpeg;base64,a',
      });
      const b = await svc.addPhoto({
        libraryId: LIBRARY_ID,
        originalName: 'b.jpg',
        dataUrl: 'data:image/jpeg;base64,b',
      });
      const c = await svc.addPhoto({
        libraryId: LIBRARY_ID,
        originalName: 'c.jpg',
        dataUrl: 'data:image/jpeg;base64,c',
      });

      await svc.updatePhoto(a.id, { rating: 1 });
      await svc.updatePhoto(b.id, { rating: 3 });
      await svc.updatePhoto(c.id, { rating: 5 });

      const threePlus = await svc.listPhotos({ libraryId: LIBRARY_ID, minRating: 3 });
      expect(new Set(threePlus.photos.map((p) => p.id))).toEqual(new Set([b.id, c.id]));

      // Pagination still works on top of the filter.
      const paged = await svc.listPhotos({
        libraryId: LIBRARY_ID,
        minRating: 3,
        pageSize: 1,
      });
      expect(paged.photos).toHaveLength(1);
      expect(paged.nextPageToken).not.toBeNull();
    });

    it('filters by flag including unflagged', async () => {
      const svc = new InMemoryLibraryService();
      const pick = await svc.addPhoto({
        libraryId: LIBRARY_ID,
        originalName: 'pick.jpg',
        dataUrl: 'data:image/jpeg;base64,pick',
      });
      const reject = await svc.addPhoto({
        libraryId: LIBRARY_ID,
        originalName: 'reject.jpg',
        dataUrl: 'data:image/jpeg;base64,reject',
      });
      const none = await svc.addPhoto({
        libraryId: LIBRARY_ID,
        originalName: 'none.jpg',
        dataUrl: 'data:image/jpeg;base64,none',
      });

      await svc.updatePhoto(pick.id, { flag: 'pick' });
      await svc.updatePhoto(reject.id, { flag: 'reject' });

      const picks = await svc.listPhotos({ libraryId: LIBRARY_ID, flag: 'pick' });
      expect(picks.photos.map((p) => p.id)).toEqual([pick.id]);

      const rejects = await svc.listPhotos({ libraryId: LIBRARY_ID, flag: 'reject' });
      expect(rejects.photos.map((p) => p.id)).toEqual([reject.id]);

      const unflagged = await svc.listPhotos({ libraryId: LIBRARY_ID, flag: 'unflagged' });
      expect(unflagged.photos.map((p) => p.id)).toEqual([none.id]);
    });

    it('scopes triage filters per library (cross-tenant isolation)', async () => {
      const svc = new InMemoryLibraryService();
      const otherLibrary = 'library-other-user';

      const mine = await svc.addPhoto({
        libraryId: LIBRARY_ID,
        originalName: 'mine.jpg',
        dataUrl: 'data:image/jpeg;base64,mine',
      });
      const theirs = await svc.addPhoto({
        libraryId: otherLibrary,
        originalName: 'theirs.jpg',
        dataUrl: 'data:image/jpeg;base64,theirs',
      });

      await svc.updatePhoto(mine.id, { rating: 5, flag: 'pick' });
      await svc.updatePhoto(theirs.id, { rating: 5, flag: 'pick' });

      const myPicks = await svc.listPhotos({
        libraryId: LIBRARY_ID,
        minRating: 5,
        flag: 'pick',
      });
      expect(myPicks.photos.map((p) => p.id)).toEqual([mine.id]);
      expect(myPicks.photos.find((p) => p.id === theirs.id)).toBeUndefined();
    });
  });
});
