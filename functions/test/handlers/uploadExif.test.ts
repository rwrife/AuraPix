/**
 * Issue #151: extract EXIF metadata on upload.
 *
 * Verifies:
 * - normalized `exif` summary lands on the stored photo doc
 * - `upload.accepted` metering event carries `meta.exifExtracted`,
 *   `meta.widthPx`, `meta.heightPx`
 * - corrupt-EXIF (and missing-EXIF) uploads still succeed and emit
 *   `meta.exifExtracted=false`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { handleUpload } from '../../src/handlers/images/upload.js';
import type { DataAdapter } from '../../src/adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../../src/adapters/storage/StorageAdapter.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../../src/services/metering/MeteringBus.js';
import { setMeteringBus } from '../../src/services/metering/index.js';

function createDataAdapter(stored: { photo?: any }): DataAdapter {
  return {
    storeData: vi.fn(async (_collection: string, _id: string, data: any) => {
      stored.photo = data;
    }),
    fetchData: vi.fn(async () => null),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(),
    deleteData: vi.fn(),
    exists: vi.fn(async () => false),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => null),
  };
}

function createStorageAdapter(): StorageAdapter {
  return {
    storeFile: vi.fn(),
    readFile: vi.fn(async () => Buffer.alloc(0)),
    fileExists: vi.fn(async () => false),
    deleteFile: vi.fn(),
    listFiles: vi.fn(async () => []),
    getFileSize: vi.fn(async () => 0),
  };
}

class CapturingSink implements MeteringSink {
  public delivered: NormalizedMeteringEvent[] = [];
  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    this.delivered.push(...events);
  }
}

async function makeJpegWithExif(): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .withExif({
      IFD0: {
        Make: 'Sony',
        Model: 'ILCE-7M4',
        Orientation: '1',
      },
      IFD2: {
        DateTimeOriginal: '2024:03:14 09:26:53',
        FNumber: '2.8',
        ExposureTime: '0.008',
        ISO: '400',
        FocalLength: '50',
        LensModel: 'FE 24-70mm F2.8 GM',
      },
    } as any)
    .jpeg()
    .toBuffer();
}

async function makePlainJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: 200, g: 200, b: 200 },
    },
  })
    .jpeg()
    .toBuffer();
}

function buildRequest(file: { buffer: Buffer; originalname: string; mimetype: string }, deps: {
  storageAdapter: StorageAdapter;
  dataAdapter: DataAdapter;
}) {
  return {
    params: { libraryId: 'lib-1' },
    user: { uid: 'user-1' },
    file: { ...file, size: file.buffer.length },
    header: () => undefined,
    app: { locals: deps },
  } as any;
}

describe('handleUpload — EXIF extraction (#151)', () => {
  let sink: CapturingSink;
  let bus: MeteringBus;

  beforeEach(() => {
    sink = new CapturingSink();
    bus = new MeteringBus({ sink, flushIntervalMs: 5, maxBatchSize: 1 });
    setMeteringBus(bus);
  });

  afterEach(async () => {
    await bus.shutdown?.().catch(() => {});
    setMeteringBus(null);
  });

  it('persists normalized exif and emits exifExtracted=true with pixel dims', async () => {
    const buffer = await makeJpegWithExif();
    const stored: { photo?: any } = {};
    const req = buildRequest(
      { buffer, originalname: 'sony.jpg', mimetype: 'image/jpeg' },
      {
        storageAdapter: createStorageAdapter(),
        dataAdapter: createDataAdapter(stored),
      }
    );
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleUpload(req, res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(stored.photo).toBeDefined();
    expect(stored.photo.exif).toMatchObject({
      camera: expect.stringMatching(/Sony.*ILCE-7M4/i),
      widthPx: 64,
      heightPx: 48,
    });
    // capturedAt should be ISO-8601 derived from EXIF DateTimeOriginal.
    expect(stored.photo.exif.capturedAt).toMatch(/^2024-03-14T/);

    // Allow the bus to flush.
    await new Promise((r) => setTimeout(r, 20));

    const uploadAccepted = sink.delivered.find((e) => e.type === 'upload.accepted');
    expect(uploadAccepted).toBeDefined();
    expect(uploadAccepted!.meta).toMatchObject({
      exifExtracted: true,
      widthPx: 64,
      heightPx: 48,
    });
  });

  it('still succeeds for JPEGs without EXIF and emits exifExtracted=false', async () => {
    const buffer = await makePlainJpeg();
    const stored: { photo?: any } = {};
    const req = buildRequest(
      { buffer, originalname: 'plain.jpg', mimetype: 'image/jpeg' },
      {
        storageAdapter: createStorageAdapter(),
        dataAdapter: createDataAdapter(stored),
      }
    );
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleUpload(req, res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(stored.photo).toBeDefined();
    // Even without EXIF, we have pixel dims from sharp, so summary may exist
    // but capturedAt / camera / lens must be absent.
    expect(stored.photo.exif?.capturedAt).toBeUndefined();
    expect(stored.photo.exif?.camera).toBeUndefined();

    await new Promise((r) => setTimeout(r, 20));

    const uploadAccepted = sink.delivered.find((e) => e.type === 'upload.accepted');
    expect(uploadAccepted).toBeDefined();
    expect(uploadAccepted!.meta).toMatchObject({ exifExtracted: false });
    expect(uploadAccepted!.meta).toMatchObject({ widthPx: 32, heightPx: 32 });
  });

  it('survives a corrupt-EXIF buffer (does not fail the upload)', async () => {
    // A "JPEG" with garbage bytes — sharp may fail metadata, exifr will fail.
    const buffer = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1]), // SOI + APP1 marker
      Buffer.from('CORRUPT-EXIF-DATA-NOT-A-REAL-IMAGE'),
    ]);
    const stored: { photo?: any } = {};
    const req = buildRequest(
      { buffer, originalname: 'corrupt.jpg', mimetype: 'image/jpeg' },
      {
        storageAdapter: createStorageAdapter(),
        dataAdapter: createDataAdapter(stored),
      }
    );
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleUpload(req, res);

    expect(res.status).toHaveBeenCalledWith(202);

    await new Promise((r) => setTimeout(r, 20));

    const uploadAccepted = sink.delivered.find((e) => e.type === 'upload.accepted');
    expect(uploadAccepted).toBeDefined();
    expect(uploadAccepted!.meta).toMatchObject({ exifExtracted: false });
  });
});
