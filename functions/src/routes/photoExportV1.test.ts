import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import sharp from 'sharp';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../adapters/storage/StorageAdapter.js';
import type { Photo } from '../models/Photo.js';
import { errorHandler } from '../middleware/errorHandler.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../services/metering/MeteringBus.js';
import { setMeteringBus } from '../services/metering/index.js';
import {
  InMemoryUsageMeteringBus,
  type UsageMeteringEvent,
} from '../services/metering/UsageMeteringBus.js';
import { createPhotoExportRouter } from './photoExportV1.js';
import {
  TENANT_EXPORT_PRESETS_COLLECTION,
  type TenantExportPresetsRecord,
} from '../models/ExportPreset.js';

class CapturingSink implements MeteringSink {
  events: NormalizedMeteringEvent[] = [];
  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

function makePhoto(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 'photo-1',
    libraryId: 'lib-1',
    albumIds: [],
    originalName: 'test.jpg',
    metadata: { width: 800, height: 600, mimeType: 'image/jpeg', sizeBytes: 1234 },
    status: 'ready',
    currentEditVersion: 0,
    editHistory: [],
    thumbnailsOutdated: false,
    storagePath: `images/lib-1/photo-1/original.jpg`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface MemoryStorage {
  storage: StorageAdapter;
  /** Lookup map keyed by absolute path. */
  files: Map<string, Buffer>;
}

function makeStorage(initial: Record<string, Buffer> = {}): MemoryStorage {
  const files = new Map<string, Buffer>(Object.entries(initial));
  const storage: StorageAdapter = {
    storeFile: vi.fn(async (path: string, buf: Buffer) => {
      files.set(path, buf);
    }),
    readFile: vi.fn(async (path: string) => {
      const b = files.get(path);
      if (!b) throw new Error(`ENOENT: ${path}`);
      return b;
    }),
    fileExists: vi.fn(async (path: string) => files.has(path)),
    deleteFile: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    listFiles: vi.fn(async (prefix: string) => {
      return [...files.keys()].filter((k) => k.startsWith(prefix));
    }),
    getFileSize: vi.fn(async (path: string) => files.get(path)?.length ?? 0),
  } as unknown as StorageAdapter;
  return { storage, files };
}

function makeData(
  photo: Photo | null,
  presetDoc?: TenantExportPresetsRecord
): DataAdapter {
  return {
    storeData: vi.fn(async () => {}),
    fetchData: vi.fn(async <T>(collection: string, id: string) => {
      if (collection === 'photos') {
        return photo as unknown as T | null;
      }
      if (collection === TENANT_EXPORT_PRESETS_COLLECTION && presetDoc) {
        return presetDoc as unknown as T;
      }
      return null;
    }),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(async () => {}),
    deleteData: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => photo),
  } as unknown as DataAdapter;
}

async function makeTinyJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: { r: 220, g: 100, b: 50 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function makeApp(opts: {
  data: DataAdapter;
  storage: StorageAdapter;
  usageBus?: InMemoryUsageMeteringBus;
  inject: (req: any) => void;
}): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    opts.inject(req);
    next();
  });
  const handle = createPhotoExportRouter({
    dataAdapter: opts.data,
    storageAdapter: opts.storage,
  });
  if (opts.usageBus) handle.setUsageBus(opts.usageBus);
  app.use('/v1/photos', handle.router);
  app.use(errorHandler);
  return app;
}

async function request(
  app: Express,
  method: 'get' | 'post',
  path: string,
  body?: unknown
): Promise<{ status: number; body: any; headers: Headers; bytes: Buffer }> {
  const { createServer } = await import('node:http');
  const server = createServer(app as unknown as (req: any, res: any) => void);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: method.toUpperCase(),
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let parsed: any;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch {
      parsed = buf.toString('utf8');
    }
    return { status: res.status, body: parsed, headers: res.headers, bytes: buf };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('POST /v1/photos/:id/export', () => {
  let sink: CapturingSink;
  let bus: MeteringBus;

  beforeEach(() => {
    // The export service requires SIGNING_MASTER_SECRET to be a hex string.
    process.env.SIGNING_MASTER_SECRET =
      process.env.SIGNING_MASTER_SECRET ?? 'a'.repeat(64);
    sink = new CapturingSink();
    bus = new MeteringBus({ sink, flushIntervalMs: 5, maxBatchSize: 1 });
    setMeteringBus(bus);
  });
  afterEach(() => {
    setMeteringBus(null);
    vi.restoreAllMocks();
  });

  it('returns 401 when no auth context is present', async () => {
    const photo = makePhoto();
    const data = makeData(photo);
    const { storage } = makeStorage();
    const app = makeApp({ data, storage, inject: () => {} });
    const res = await request(app, 'post', '/v1/photos/photo-1/export', {
      preset: 'web-small',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('returns 400 when `preset` is missing', async () => {
    const photo = makePhoto();
    const data = makeData(photo);
    const { storage } = makeStorage();
    const app = makeApp({
      data,
      storage,
      inject: (req) => {
        req.user = { uid: 'u_1' };
      },
    });
    const res = await request(app, 'post', '/v1/photos/photo-1/export', {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRESET_REQUIRED');
  });

  it('returns 404 when the photo does not exist', async () => {
    const data = makeData(null);
    const { storage } = makeStorage();
    const app = makeApp({
      data,
      storage,
      inject: (req) => {
        req.user = { uid: 'u_1' };
      },
    });
    const res = await request(app, 'post', '/v1/photos/photo-1/export', {
      preset: 'web-small',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PHOTO_NOT_FOUND');
  });

  it('returns 404 when the preset is not configured for the tenant', async () => {
    const photo = makePhoto({ tenantId: 'tenant-a' });
    const data = makeData(photo);
    const { storage } = makeStorage();
    const app = makeApp({
      data,
      storage,
      inject: (req) => {
        req.user = { uid: 'u_1' };
        req.tenantId = 'tenant-a';
      },
    });
    const res = await request(app, 'post', '/v1/photos/photo-1/export', {
      preset: 'ghost',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PRESET_NOT_FOUND');
  });

  it('returns 409 when the photo is in trash', async () => {
    const photo = makePhoto({ trashedAt: new Date().toISOString() });
    const data = makeData(photo);
    const { storage } = makeStorage();
    const app = makeApp({
      data,
      storage,
      inject: (req) => {
        req.user = { uid: 'u_1' };
      },
    });
    const res = await request(app, 'post', '/v1/photos/photo-1/export', {
      preset: 'web-small',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PHOTO_TRASHED');
  });

  it('renders an export, returns a signed URL, and emits photo.exported with cacheHit:false then cacheHit:true', async () => {
    const tiny = await makeTinyJpeg();
    const photo = makePhoto({ tenantId: 'tenant-a' });
    const data = makeData(photo);
    const { storage, files } = makeStorage({
      [`images/lib-1/photo-1/original.jpg`]: tiny,
    });
    const usageBus = new InMemoryUsageMeteringBus();
    const usageEvents: UsageMeteringEvent[] = [];
    usageBus.subscribe((e) => {
      usageEvents.push(e);
    });
    const app = makeApp({
      data,
      storage,
      usageBus,
      inject: (req) => {
        req.user = { uid: 'u_1' };
        req.tenantId = 'tenant-a';
      },
    });
    const first = await request(app, 'post', '/v1/photos/photo-1/export', {
      preset: 'web-small',
    });
    expect(first.status).toBe(200);
    expect(first.body.preset).toBe('web-small');
    expect(first.body.cacheHit).toBe(false);
    expect(first.body.outputBytes).toBeGreaterThan(0);
    expect(typeof first.body.url).toBe('string');
    expect(first.body.url).toContain('/v1/photos/photo-1/export/');
    // Cache write happened.
    expect([...files.keys()].some((k) => k.startsWith('exports/lib-1/'))).toBe(true);

    // Second call hits the cache.
    const second = await request(app, 'post', '/v1/photos/photo-1/export', {
      preset: 'web-small',
    });
    expect(second.status).toBe(200);
    expect(second.body.cacheHit).toBe(true);

    // Flush metering and inspect events.
    await bus.flush();
    const exportEvents = sink.events.filter((e) => e.type === 'photo.exported');
    expect(exportEvents).toHaveLength(2);
    expect(exportEvents[0]?.bytes).toBe(first.body.outputBytes);
    expect((exportEvents[0]?.meta as any).cacheHit).toBe(false);
    expect((exportEvents[1]?.meta as any).cacheHit).toBe(true);
    expect((exportEvents[0]?.meta as any).preset).toBe('web-small');

    // exportBytes counter incremented twice.
    const counts = usageEvents.filter((e) => e.counter === 'exportBytes');
    expect(counts).toHaveLength(2);
    expect(counts[0]?.value).toBeGreaterThan(0);
  });

  it('rejects cross-tenant access with 403', async () => {
    const tiny = await makeTinyJpeg();
    const photo = makePhoto({ tenantId: 'tenant-a' });
    const data = makeData(photo);
    const { storage } = makeStorage({
      [`images/lib-1/photo-1/original.jpg`]: tiny,
    });
    const app = makeApp({
      data,
      storage,
      inject: (req) => {
        req.user = { uid: 'u_1' };
        req.tenantId = 'tenant-other';
      },
    });
    const res = await request(app, 'post', '/v1/photos/photo-1/export', {
      preset: 'web-small',
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /v1/photos/:id/export/:token', () => {
  beforeEach(() => {
    process.env.SIGNING_MASTER_SECRET =
      process.env.SIGNING_MASTER_SECRET ?? 'a'.repeat(64);
  });

  it('returns 401 on an invalid token', async () => {
    const data = makeData(makePhoto());
    const { storage } = makeStorage();
    const app = makeApp({ data, storage, inject: () => {} });
    const res = await request(
      app,
      'get',
      '/v1/photos/photo-1/export/this-is-not-a-token'
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  it('round-trips a token issued by POST and streams the JPEG bytes', async () => {
    const tiny = await makeTinyJpeg();
    const photo = makePhoto({ tenantId: 'tenant-a' });
    const data = makeData(photo);
    const { storage } = makeStorage({
      [`images/lib-1/photo-1/original.jpg`]: tiny,
    });
    const app = makeApp({
      data,
      storage,
      inject: (req) => {
        req.user = { uid: 'u_1' };
        req.tenantId = 'tenant-a';
      },
    });
    const post = await request(app, 'post', '/v1/photos/photo-1/export', {
      preset: 'web-small',
    });
    expect(post.status).toBe(200);
    const url: string = post.body.url;
    const pathOnly = url.replace(/^https?:\/\/[^/]+/, '');
    const get = await request(app, 'get', pathOnly);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/jpeg');
    expect(get.bytes.length).toBeGreaterThan(0);
    // First two bytes of a JPEG.
    expect(get.bytes[0]).toBe(0xff);
    expect(get.bytes[1]).toBe(0xd8);
  });
});
