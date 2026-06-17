/**
 * Issue #151: photo list endpoint with `?sort=capturedAt` support.
 *
 * Uses an in-process Express app via Node's http.Server and undici-style fetch
 * is overkill here; instead, we mount the router and drive it with the Express
 * handler signature directly through a tiny mock req/res helper.
 */
import { describe, expect, it, vi } from 'vitest';
import { createPhotosV1Router } from '../../src/routes/photosV1.js';
import type { DataAdapter } from '../../src/adapters/data/DataAdapter.js';
import type { Photo } from '../../src/models/Photo.js';

function makePhoto(over: Partial<Photo> = {}): Photo {
  return {
    id: over.id ?? 'p1',
    libraryId: 'lib-1',
    tenantId: 'tenant-a',
    albumIds: [],
    originalName: 'a.jpg',
    storagePaths: undefined as any,
    metadata: { width: 100, height: 100, mimeType: 'image/jpeg', sizeBytes: 1 },
    status: 'ready',
    currentEditVersion: 0,
    editHistory: [],
    thumbnailsOutdated: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeAdapter(photos: Photo[]): DataAdapter {
  return {
    storeData: vi.fn(),
    fetchData: vi.fn(async () => null),
    queryData: vi.fn(async () => photos as any),
    updateData: vi.fn(),
    deleteData: vi.fn(),
    exists: vi.fn(async () => false),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => null),
  };
}

/**
 * Pull the GET '/' handler out of an Express Router. Routers expose their
 * registered layers via `router.stack`. We grab the first non-middleware layer
 * since our router only registers a single GET '/'.
 */
function getRootGet(router: any) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === '/') {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle as (
        req: any,
        res: any,
        next: any
      ) => unknown;
    }
  }
  throw new Error('GET / not registered on router');
}

async function callGet(
  adapter: DataAdapter,
  query: Record<string, string>,
  user: { uid: string; tenantId?: string } | null
): Promise<{ status: number; body: any }> {
  const router = createPhotosV1Router(adapter);
  const handler = getRootGet(router);
  const captured: { status: number; body: any } = { status: 200, body: undefined };
  const res: any = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: any) {
      captured.body = body;
      return this;
    },
  };
  const req: any = { query, user };
  await new Promise<void>((resolve, reject) => {
    Promise.resolve(handler(req, res, (err: unknown) => (err ? reject(err) : resolve())))
      .then(() => resolve())
      .catch(reject);
  });
  return captured;
}

describe('GET /api/v1/photos (#151)', () => {
  it('rejects unauthenticated requests', async () => {
    const r = await callGet(makeAdapter([]), { libraryId: 'lib-1' }, null);
    expect(r.status).toBe(401);
  });

  it('requires libraryId', async () => {
    const r = await callGet(makeAdapter([]), {}, { uid: 'u' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_QUERY');
  });

  it('rejects unknown sort keys', async () => {
    const r = await callGet(
      makeAdapter([]),
      { libraryId: 'lib-1', sort: 'bogus' },
      { uid: 'u' }
    );
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_QUERY');
  });

  it('sorts by capturedAt ascending and descending', async () => {
    const photos = [
      makePhoto({ id: 'old', exif: { capturedAt: '2020-05-01T10:00:00.000Z' } }),
      makePhoto({ id: 'new', exif: { capturedAt: '2024-06-01T10:00:00.000Z' } }),
      makePhoto({ id: 'mid', exif: { capturedAt: '2022-03-15T10:00:00.000Z' } }),
    ];

    const asc = await callGet(
      makeAdapter(photos),
      { libraryId: 'lib-1', sort: 'capturedAt' },
      { uid: 'u' }
    );
    expect(asc.status).toBe(200);
    expect(asc.body.photos.map((p: any) => p.id)).toEqual(['old', 'mid', 'new']);

    const desc = await callGet(
      makeAdapter(photos),
      { libraryId: 'lib-1', sort: '-capturedAt' },
      { uid: 'u' }
    );
    expect(desc.status).toBe(200);
    expect(desc.body.photos.map((p: any) => p.id)).toEqual(['new', 'mid', 'old']);
  });

  it('falls back to upload time (createdAt) when capturedAt is missing', async () => {
    const photos = [
      makePhoto({ id: 'no-exif', createdAt: '2023-01-01T00:00:00.000Z' }),
      makePhoto({
        id: 'has-exif',
        createdAt: '2024-01-01T00:00:00.000Z',
        exif: { capturedAt: '2022-01-01T00:00:00.000Z' },
      }),
    ];
    const r = await callGet(
      makeAdapter(photos),
      { libraryId: 'lib-1', sort: 'capturedAt' },
      { uid: 'u' }
    );
    expect(r.status).toBe(200);
    expect(r.body.photos.map((p: any) => p.id)).toEqual(['has-exif', 'no-exif']);
  });

  it('scopes results to the requester tenant', async () => {
    const photos = [
      makePhoto({ id: 'mine', tenantId: 'tenant-a' }),
      makePhoto({ id: 'theirs', tenantId: 'tenant-b' }),
    ];
    const r = await callGet(
      makeAdapter(photos),
      { libraryId: 'lib-1' },
      { uid: 'u', tenantId: 'tenant-a' }
    );
    expect(r.status).toBe(200);
    expect(r.body.photos.map((p: any) => p.id)).toEqual(['mine']);
  });
});
