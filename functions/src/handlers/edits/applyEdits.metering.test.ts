import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleApplyEdits } from './applyEdits.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import type { Photo } from '../../models/Photo.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../../services/metering/MeteringBus.js';
import { setMeteringBus } from '../../services/metering/index.js';

class CapturingSink implements MeteringSink {
  events: NormalizedMeteringEvent[] = [];
  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

function createPhoto(): Photo {
  return {
    id: 'photo-1',
    libraryId: 'lib-1',
    albumIds: [],
    originalName: 'test.jpg',
    metadata: { width: 100, height: 100, mimeType: 'image/jpeg', sizeBytes: 123 },
    status: 'ready',
    currentEditVersion: 0,
    editHistory: [],
    thumbnailsOutdated: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeDataAdapter(photo: Photo | null, updateImpl?: () => Promise<void>): DataAdapter {
  return {
    storeData: vi.fn(async () => {}),
    fetchData: vi.fn(async () => photo),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(updateImpl ?? (async () => {})),
    deleteData: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => photo),
  } as unknown as DataAdapter;
}

function makeStorage(): StorageAdapter {
  return {
    storeFile: vi.fn(),
    readFile: vi.fn(async () => Buffer.alloc(0)),
    fileExists: vi.fn(async () => true),
    deleteFile: vi.fn(),
    listFiles: vi.fn(async () => []),
    getFileSize: vi.fn(async () => 0),
  } as unknown as StorageAdapter;
}

function makeRes() {
  const res: any = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function makeReq(operations: { type: string; params: Record<string, unknown>; order: number }[]) {
  return {
    params: { libraryId: 'lib-1', photoId: 'photo-1' },
    user: { uid: 'user-1' },
    header: () => undefined,
    body: { recipeVersion: 1, operations },
    app: {
      locals: {
        dataAdapter: undefined as unknown as DataAdapter,
        storageAdapter: undefined as unknown as StorageAdapter,
      },
    },
  };
}

describe('applyEdits plugin.ran metering', () => {
  let sink: CapturingSink;
  let bus: MeteringBus;

  beforeEach(() => {
    sink = new CapturingSink();
    bus = new MeteringBus({ sink, flushIntervalMs: 10, maxBatchSize: 1 });
    setMeteringBus(bus);
  });

  afterEach(() => {
    setMeteringBus(null);
    vi.restoreAllMocks();
  });

  it('emits one plugin.ran event per operation on success', async () => {
    const photo = createPhoto();
    const data = makeDataAdapter(photo);
    const storage = makeStorage();
    const req: any = makeReq([
      { type: 'rotate', params: { degrees: 90 }, order: 0 },
      { type: 'filter', params: { filterName: 'grayscale' }, order: 1 },
    ]);
    req.app.locals.dataAdapter = data;
    req.app.locals.storageAdapter = storage;
    const res = makeRes();

    await handleApplyEdits(req, res);
    await bus.flush();

    const pluginEvents = sink.events.filter((e) => e.type === 'plugin.ran');
    expect(pluginEvents).toHaveLength(2);
    for (const ev of pluginEvents) {
      expect(ev.tenantId).toBe('lib:lib-1');
      expect(ev.resourceId).toBe('photo-1');
      expect(ev.meta).toMatchObject({ libraryId: 'lib-1', success: true });
      expect(typeof (ev.meta as any).durationMs).toBe('number');
      expect(typeof (ev.meta as any).pluginId).toBe('string');
    }
    expect(pluginEvents.map((e) => (e.meta as any).pluginId).sort()).toEqual(['filter', 'rotate']);
  });

  it('emits plugin.ran with success=false when the commit fails, exactly once per op', async () => {
    const photo = createPhoto();
    const data = makeDataAdapter(photo, async () => {
      throw new Error('boom');
    });
    const storage = makeStorage();
    const req: any = makeReq([
      { type: 'rotate', params: { degrees: 90 }, order: 0 },
      { type: 'filter', params: { filterName: 'sepia' }, order: 1 },
    ]);
    req.app.locals.dataAdapter = data;
    req.app.locals.storageAdapter = storage;
    const res = makeRes();

    await expect(handleApplyEdits(req, res)).rejects.toBeDefined();
    await bus.flush();

    const pluginEvents = sink.events.filter((e) => e.type === 'plugin.ran');
    expect(pluginEvents).toHaveLength(2);
    for (const ev of pluginEvents) {
      expect(ev.meta).toMatchObject({ libraryId: 'lib-1', success: false });
    }
    // No `edit.applied` should have leaked through on failure.
    expect(sink.events.filter((e) => e.type === 'edit.applied')).toHaveLength(0);
  });

  it('does NOT emit plugin.ran when validation fails (no plugin actually ran)', async () => {
    const photo = createPhoto();
    const data = makeDataAdapter(photo);
    const storage = makeStorage();
    // crop missing required fields -> validateOperations rejects before commit
    const req: any = makeReq([{ type: 'crop', params: {}, order: 0 }]);
    req.app.locals.dataAdapter = data;
    req.app.locals.storageAdapter = storage;
    const res = makeRes();

    await expect(handleApplyEdits(req, res)).rejects.toBeDefined();
    await bus.flush();

    expect(sink.events.filter((e) => e.type === 'plugin.ran')).toHaveLength(0);
  });
});
