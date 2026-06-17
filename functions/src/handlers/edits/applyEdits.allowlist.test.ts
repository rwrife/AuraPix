import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleApplyEdits } from './applyEdits.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import type { Photo } from '../../models/Photo.js';
import { TENANT_PLUGIN_CONFIG_COLLECTION } from '../../models/TenantPluginConfig.js';
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
  } as Photo;
}

/**
 * Build a collection-aware DataAdapter so we can simulate both the photo
 * lookup and a separate `tenantPluginConfig` doc.
 */
function makeAwareAdapter(opts: {
  photo: Photo | null;
  pluginConfig?: Record<string, unknown> | null;
  updateImpl?: () => Promise<void>;
}): DataAdapter {
  return {
    storeData: vi.fn(async () => {}),
    fetchData: vi.fn(async (collection: string, _id: string) => {
      if (collection === TENANT_PLUGIN_CONFIG_COLLECTION) {
        return opts.pluginConfig ?? null;
      }
      return opts.photo;
    }),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(opts.updateImpl ?? (async () => {})),
    deleteData: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => opts.photo),
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

describe('applyEdits per-tenant allowlist enforcement (#166)', () => {
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

  it('runs normally when the tenant has no explicit config (default-on)', async () => {
    const data = makeAwareAdapter({
      photo: createPhoto(),
      pluginConfig: null,
    });
    const storage = makeStorage();
    const req: any = makeReq([
      { type: 'rotate', params: { degrees: 90 }, order: 0 },
    ]);
    req.app.locals.dataAdapter = data;
    req.app.locals.storageAdapter = storage;
    const res = makeRes();

    await handleApplyEdits(req, res);
    await bus.flush();

    // No blocked events; plugin.ran fired once for the successful op.
    expect(sink.events.filter((e) => e.type === 'plugin.blocked')).toHaveLength(0);
    expect(sink.events.filter((e) => e.type === 'plugin.ran')).toHaveLength(1);
  });

  it('blocks a disabled plugin with 403 plugin_disabled_for_tenant and emits plugin.blocked', async () => {
    const data = makeAwareAdapter({
      photo: createPhoto(),
      pluginConfig: {
        tenantId: 'lib:lib-1',
        // rotate is intentionally NOT in the allowlist.
        enabledPluginIds: ['crop', 'adjust', 'filter'],
        updatedAt: '2024-01-01T00:00:00.000Z',
        updatedBy: null,
      },
    });
    const storage = makeStorage();
    const req: any = makeReq([
      { type: 'rotate', params: { degrees: 90 }, order: 0 },
    ]);
    req.app.locals.dataAdapter = data;
    req.app.locals.storageAdapter = storage;
    const res = makeRes();

    await expect(handleApplyEdits(req, res)).rejects.toMatchObject({
      statusCode: 403,
      code: 'plugin_disabled_for_tenant',
    });

    // Storage was never written.
    expect((data.updateData as any).mock.calls.length).toBe(0);

    await bus.flush();
    const blocked = sink.events.filter((e) => e.type === 'plugin.blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].tenantId).toBe('lib:lib-1');
    expect(blocked[0].resourceId).toBe('photo-1');
    expect((blocked[0].meta as any).pluginId).toBe('rotate');
    expect((blocked[0].meta as any).userId).toBe('user-1');

    // No plugin.ran emitted because the plugin never ran.
    expect(sink.events.filter((e) => e.type === 'plugin.ran')).toHaveLength(0);
  });

  it('blocks the first disabled plugin and stops processing the rest', async () => {
    const data = makeAwareAdapter({
      photo: createPhoto(),
      pluginConfig: {
        tenantId: 'lib:lib-1',
        // Only `crop` is enabled.
        enabledPluginIds: ['crop'],
        updatedAt: '2024-01-01T00:00:00.000Z',
        updatedBy: null,
      },
    });
    const storage = makeStorage();
    const req: any = makeReq([
      { type: 'rotate', params: { degrees: 90 }, order: 0 },
      { type: 'filter', params: { filterName: 'sepia' }, order: 1 },
    ]);
    req.app.locals.dataAdapter = data;
    req.app.locals.storageAdapter = storage;
    const res = makeRes();

    await expect(handleApplyEdits(req, res)).rejects.toMatchObject({
      statusCode: 403,
      code: 'plugin_disabled_for_tenant',
    });

    await bus.flush();
    // Only the first disabled plugin produces a blocked event.
    const blocked = sink.events.filter((e) => e.type === 'plugin.blocked');
    expect(blocked).toHaveLength(1);
    expect((blocked[0].meta as any).pluginId).toBe('rotate');
  });
});
