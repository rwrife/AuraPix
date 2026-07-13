/**
 * Unit tests for `POST /v1/photos:search` (issue #207).
 */
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { Photo } from '../models/Photo.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { createPhotosSearchV1Router } from './photosSearchV1.js';

interface InjectCtx {
  tenantId?: string;
  userId?: string;
}

function makeApp(
  data: DataAdapter,
  ctx: InjectCtx = { tenantId: 'tenant-a', userId: 'u1' }
): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (ctx.userId) {
      (req as express.Request & { user?: unknown }).user = {
        uid: ctx.userId,
        // tenantId is not part of AuthUser but our route reads it via a cast.
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      } as unknown as express.Request['user'];
    }
    if (ctx.tenantId) {
      (req as express.Request & { tenantId?: string }).tenantId = ctx.tenantId;
    }
    next();
  });
  app.use('/v1/photos:search', createPhotosSearchV1Router(data));
  app.use(errorHandler);
  return app;
}

function makeAdapter(seedPhotos: Photo[]): DataAdapter {
  const photos = new Map<string, Photo>(seedPhotos.map((p) => [p.id, p]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = {
    storeData: vi.fn(async (_c: string, id: string, v: Photo) => {
      photos.set(id, v);
    }),
    fetchData: vi.fn(async (_c: string, id: string) => photos.get(id) ?? null),
    queryData: vi.fn(
      async (
        _c: string,
        filters: Array<{ field: string; operator: string; value: unknown }>
      ) => {
        const out: Photo[] = [];
        for (const p of photos.values()) {
          let ok = true;
          for (const f of filters) {
            if (f.operator !== '==') continue;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((p as any)[f.field] !== f.value) {
              ok = false;
              break;
            }
          }
          if (ok) out.push(p);
        }
        return out;
      }
    ),
    updateData: vi.fn(),
    deleteData: vi.fn(),
    exists: vi.fn(async () => false),
    listIds: vi.fn(async () => Array.from(photos.keys())),
    getPhoto: vi.fn(async () => null),
  };
  return data as DataAdapter;
}

function makePhoto(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 'p1',
    libraryId: 'lib-a',
    tenantId: 'tenant-a',
    albumIds: [],
    originalName: 'Sunset.jpg',
    filenameLower: 'sunset.jpg',
    metadata: {
      width: 100,
      height: 100,
      mimeType: 'image/jpeg',
      sizeBytes: 100,
      cameraMake: 'Canon',
      cameraModel: 'Canon EOS 5D',
    },
    status: 'ready',
    currentEditVersion: 0,
    editHistory: [],
    thumbnailsOutdated: false,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    tags: [],
    rating: 0,
    flag: null,
    colorLabel: null,
    ...overrides,
  } as Photo;
}

async function post(
  app: Express,
  path: string,
  body: unknown
): Promise<{ status: number; body: unknown }> {
  const { createServer } = await import('node:http');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createServer(app as unknown as (req: any, res: any) => void);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('POST /v1/photos:search', () => {
  it('filters by filename prefix (case-insensitive)', async () => {
    const app = makeApp(
      makeAdapter([
        makePhoto({ id: 'p1', originalName: 'Sunset.jpg', filenameLower: 'sunset.jpg' }),
        makePhoto({ id: 'p2', originalName: 'Beach.jpg', filenameLower: 'beach.jpg' }),
      ])
    );
    const res = await post(app, '/v1/photos:search', {
      libraryId: 'lib-a',
      q: 'SUN',
    });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(['p1']);
  });

  it('AND-combines multiple filters (tags + rating + flag)', async () => {
    const app = makeApp(
      makeAdapter([
        makePhoto({ id: 'a', tags: ['travel', 'sunset'], rating: 5, flag: 'pick' }),
        makePhoto({ id: 'b', tags: ['travel'], rating: 5, flag: 'pick' }),
        makePhoto({ id: 'c', tags: ['travel', 'sunset'], rating: 3, flag: 'pick' }),
        makePhoto({ id: 'd', tags: ['travel', 'sunset'], rating: 5, flag: null }),
      ])
    );
    const res = await post(app, '/v1/photos:search', {
      libraryId: 'lib-a',
      tags: ['travel', 'sunset'],
      rating: { gte: 4 },
      flag: 'pick',
    });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(['a']);
  });

  it('rejects unsupported combo (missing libraryId) with 409 + hint', async () => {
    const app = makeApp(makeAdapter([]));
    const res = await post(app, '/v1/photos:search', {
      q: 'sunset',
    });
    expect(res.status).toBe(409);
    const body = res.body as { error: { code: string; hint: string } };
    expect(body.error.code).toBe('unsupported_query_combination');
    expect(typeof body.error.hint).toBe('string');
    expect(body.error.hint.length).toBeGreaterThan(0);
  });

  it('cross-tenant libraryId returns 404', async () => {
    const app = makeApp(
      makeAdapter([
        makePhoto({ id: 'p1', libraryId: 'lib-a', tenantId: 'tenant-b' }),
      ]),
      { tenantId: 'tenant-a', userId: 'u1' }
    );
    const res = await post(app, '/v1/photos:search', {
      libraryId: 'lib-a',
    });
    expect(res.status).toBe(404);
  });

  it('paginates via cursor', async () => {
    const photos = Array.from({ length: 5 }, (_, i) =>
      makePhoto({
        id: `p${i}`,
        originalName: `img${i}.jpg`,
        filenameLower: `img${i}.jpg`,
        // stagger createdAt so sort is deterministic (newest first).
        createdAt: `2026-06-0${i + 1}T00:00:00.000Z`,
      })
    );
    const app = makeApp(makeAdapter(photos));

    const first = await post(app, '/v1/photos:search', {
      libraryId: 'lib-a',
      limit: 2,
    });
    expect(first.status).toBe(200);
    const b1 = first.body as {
      items: Array<{ id: string }>;
      nextCursor?: string;
      totalEstimate: number;
    };
    expect(b1.items.length).toBe(2);
    expect(b1.totalEstimate).toBe(5);
    expect(b1.nextCursor).toBeTruthy();

    const second = await post(app, '/v1/photos:search', {
      libraryId: 'lib-a',
      limit: 2,
      cursor: b1.nextCursor,
    });
    expect(second.status).toBe(200);
    const b2 = second.body as { items: Array<{ id: string }>; nextCursor?: string };
    expect(b2.items.length).toBe(2);
    // Different page.
    expect(b2.items.map((i) => i.id)).not.toEqual(b1.items.map((i) => i.id));
  });

  it('requires authentication', async () => {
    const app = makeApp(makeAdapter([]), {});
    const res = await post(app, '/v1/photos:search', { libraryId: 'lib-a' });
    expect(res.status).toBe(401);
  });

  it('filters by camera substring match', async () => {
    const app = makeApp(
      makeAdapter([
        makePhoto({
          id: 'p1',
          metadata: {
            width: 1,
            height: 1,
            mimeType: 'image/jpeg',
            sizeBytes: 1,
            cameraMake: 'Canon',
            cameraModel: 'Canon EOS 5D Mark IV',
          },
        }),
        makePhoto({
          id: 'p2',
          metadata: {
            width: 1,
            height: 1,
            mimeType: 'image/jpeg',
            sizeBytes: 1,
            cameraMake: 'Sony',
            cameraModel: 'A7 IV',
          },
        }),
      ])
    );
    const res = await post(app, '/v1/photos:search', {
      libraryId: 'lib-a',
      camera: '5d',
    });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(['p1']);
  });

  it('excludes trashed photos by default', async () => {
    const app = makeApp(
      makeAdapter([
        makePhoto({ id: 'live' }),
        makePhoto({ id: 'gone', trashedAt: '2026-06-15T00:00:00.000Z' }),
      ])
    );
    const res = await post(app, '/v1/photos:search', { libraryId: 'lib-a' });
    const body = res.body as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(['live']);
  });

  it('trashed=true returns only trashed photos', async () => {
    const app = makeApp(
      makeAdapter([
        makePhoto({ id: 'live' }),
        makePhoto({ id: 'gone', trashedAt: '2026-06-15T00:00:00.000Z' }),
      ])
    );
    const res = await post(app, '/v1/photos:search', {
      libraryId: 'lib-a',
      trashed: true,
    });
    const body = res.body as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(['gone']);
  });
});
