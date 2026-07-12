/**
 * Enforcement tests for the per-tenant `originalDownload` feature flag
 * (issue #208) on the export-preset apply path.
 *
 * The AC calls for three unit-test axes on this route:
 *   1. Preset targets untouched original (format=original, no watermark) → gated.
 *   2. Preset downsizes (format=jpeg) → allowed even when the flag is off.
 *   3. Preset targets original but with an active watermark → allowed.
 *
 * All three use the same `tenantFeaturesConfig` fixture with the flag
 * explicitly set to `false`; the default-on behavior is covered by the
 * shared `tenantFeaturesConfigService` tests (which iterate over
 * `FEATURE_FLAG_NAMES`, so adding the new flag automatically extended
 * those cases without a new test needing to be authored here).
 */

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
import { createPhotoExportRouter } from './photoExportV1.js';
import {
  TENANT_EXPORT_PRESETS_COLLECTION,
  type ExportPreset,
  type TenantExportPresetsRecord,
} from '../models/ExportPreset.js';
import {
  TENANT_FEATURES_CONFIG_COLLECTION,
  type TenantFeaturesConfigRecord,
} from '../models/TenantFeaturesConfig.js';
import { __resetTenantFeaturesCacheForTests } from '../services/host/tenantFeaturesConfigService.js';

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
  } as Photo;
}

function makeStorage(initial: Record<string, Buffer> = {}) {
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
  presetDoc: TenantExportPresetsRecord | null,
  featuresDoc: TenantFeaturesConfigRecord | null
): DataAdapter {
  return {
    storeData: vi.fn(async () => {}),
    fetchData: vi.fn(async <T>(collection: string, _id: string) => {
      if (collection === 'photos') return photo as unknown as T | null;
      if (collection === TENANT_EXPORT_PRESETS_COLLECTION && presetDoc) {
        return presetDoc as unknown as T;
      }
      if (collection === TENANT_FEATURES_CONFIG_COLLECTION && featuresDoc) {
        return featuresDoc as unknown as T;
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

function presetDoc(tenantId: string, preset: ExportPreset): TenantExportPresetsRecord {
  return {
    tenantId,
    presets: [preset],
    updatedAt: new Date().toISOString(),
    updatedBy: null,
  };
}

function originalDownloadOff(tenantId: string): TenantFeaturesConfigRecord {
  return {
    tenantId,
    flags: { originalDownload: false },
    updatedAt: new Date().toISOString(),
    updatedBy: 'test',
  };
}

function makeApp(opts: {
  data: DataAdapter;
  storage: StorageAdapter;
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
  app.use('/v1/photos', handle.router);
  app.use(errorHandler);
  return app;
}

async function post(
  app: Express,
  path: string,
  body: unknown
): Promise<{ status: number; body: any }> {
  const { createServer } = await import('node:http');
  const server = createServer(app as unknown as (req: any, res: any) => void);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => ({}));
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('POST /v1/photos/:id/export — originalDownload gating (#208)', () => {
  let sink: CapturingSink;
  let bus: MeteringBus;

  beforeEach(() => {
    process.env.SIGNING_MASTER_SECRET =
      process.env.SIGNING_MASTER_SECRET ?? 'a'.repeat(64);
    __resetTenantFeaturesCacheForTests();
    sink = new CapturingSink();
    bus = new MeteringBus({ sink, flushIntervalMs: 5, maxBatchSize: 1 });
    setMeteringBus(bus);
  });
  afterEach(() => {
    setMeteringBus(null);
    __resetTenantFeaturesCacheForTests();
    vi.restoreAllMocks();
  });

  it('gates the untouched-original preset (format=original, no watermark) with 403 + feature.gated', async () => {
    const tenantId = 'tenant-free';
    const photo = makePhoto({ tenantId });
    const preset: ExportPreset = {
      name: 'original',
      maxEdge: 8192,
      quality: 100,
      format: 'original',
    };
    const data = makeData(
      photo,
      presetDoc(tenantId, preset),
      originalDownloadOff(tenantId)
    );
    const { storage } = makeStorage();
    const app = makeApp({
      data,
      storage,
      inject: (req) => {
        req.user = { uid: 'u_1' };
        req.tenantId = tenantId;
      },
    });
    const res = await post(app, '/v1/photos/photo-1/export', {
      preset: 'original',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('feature_disabled');
    expect(res.body.error.details?.feature).toBe('originalDownload');

    await bus.flush();
    const gated = sink.events.filter((e) => e.type === 'feature.gated');
    expect(gated).toHaveLength(1);
    expect((gated[0]?.meta as any).feature).toBe('originalDownload');
    expect((gated[0]?.meta as any).route).toBe('/v1/photos/:id/export');
  });

  it('allows a downsize preset (format=jpeg) even when originalDownload is disabled', async () => {
    const tenantId = 'tenant-free';
    const tiny = await makeTinyJpeg();
    const photo = makePhoto({ tenantId });
    const preset: ExportPreset = {
      name: 'web-small',
      maxEdge: 1024,
      quality: 80,
      format: 'jpeg',
    };
    const data = makeData(
      photo,
      presetDoc(tenantId, preset),
      originalDownloadOff(tenantId)
    );
    const { storage } = makeStorage({
      [`images/lib-1/photo-1/original.jpg`]: tiny,
    });
    const app = makeApp({
      data,
      storage,
      inject: (req) => {
        req.user = { uid: 'u_1' };
        req.tenantId = tenantId;
      },
    });
    const res = await post(app, '/v1/photos/photo-1/export', {
      preset: 'web-small',
    });
    expect(res.status).toBe(200);

    await bus.flush();
    const gated = sink.events.filter((e) => e.type === 'feature.gated');
    expect(gated).toHaveLength(0);
  });

  it('allows a format=original preset when an active watermark is applied', async () => {
    const tenantId = 'tenant-free';
    const tiny = await makeTinyJpeg();
    const photo = makePhoto({ tenantId });
    const preset: ExportPreset = {
      name: 'original-watermarked',
      maxEdge: 8192,
      quality: 100,
      format: 'original',
      watermark: {
        enabled: true,
        text: 'ACME PHOTO',
        opacity: 0.5,
        position: 'bottom-right',
      },
    };
    const data = makeData(
      photo,
      presetDoc(tenantId, preset),
      originalDownloadOff(tenantId)
    );
    const { storage } = makeStorage({
      [`images/lib-1/photo-1/original.jpg`]: tiny,
    });
    const app = makeApp({
      data,
      storage,
      inject: (req) => {
        req.user = { uid: 'u_1' };
        req.tenantId = tenantId;
      },
    });
    const res = await post(app, '/v1/photos/photo-1/export', {
      preset: 'original-watermarked',
    });
    // An active watermark means the preset is not "the untouched
    // original" and therefore is not gated by originalDownload.
    expect(res.status).toBe(200);

    await bus.flush();
    const gated = sink.events.filter((e) => e.type === 'feature.gated');
    expect(gated).toHaveLength(0);
  });
});
