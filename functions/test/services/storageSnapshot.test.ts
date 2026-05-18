import { describe, expect, it } from 'vitest';
import {
  InMemoryDailyDocStore,
} from '../../src/services/metering/UsageRollupConsumer.js';
import { snapshotTenantStorage } from '../../src/services/metering/storageSnapshot.js';
import type { StorageAdapter } from '../../src/adapters/storage/StorageAdapter.js';

function makeStorage(sizes: Record<string, number>): StorageAdapter {
  return {
    storeFile: async () => undefined,
    readFile: async () => Buffer.alloc(0),
    fileExists: async () => true,
    deleteFile: async () => undefined,
    listFiles: async (prefix: string) =>
      Object.keys(sizes).filter((p) => p.startsWith(prefix)),
    getFileSize: async (path: string) => sizes[path] ?? 0,
  };
}

describe('snapshotTenantStorage', () => {
  it('computes storageBytesTotal across a tenant\'s libraries', async () => {
    const store = new InMemoryDailyDocStore();
    const storage = makeStorage({
      'originals/lib-1/photo-a/original.jpg': 100,
      'derivatives/lib-1/photo-a/thumb.webp': 25,
      'originals/lib-2/photo-b/original.jpg': 500,
    });

    const doc = await snapshotTenantStorage('tenant-A', {
      storageAdapter: storage,
      store,
      resolveTenantLibraries: async () => ['lib-1', 'lib-2'],
      date: '2026-04-10',
    });

    expect(doc.storageBytesTotal).toBe(625);
    expect(doc.date).toBe('2026-04-10');
    expect(doc.tenantId).toBe('tenant-A');
  });

  it('is idempotent when run twice on the same day', async () => {
    const store = new InMemoryDailyDocStore();
    const storage = makeStorage({
      'originals/lib-1/photo-a/original.jpg': 100,
    });

    await snapshotTenantStorage('tenant-A', {
      storageAdapter: storage,
      store,
      resolveTenantLibraries: async () => ['lib-1'],
      date: '2026-04-11',
    });
    const second = await snapshotTenantStorage('tenant-A', {
      storageAdapter: storage,
      store,
      resolveTenantLibraries: async () => ['lib-1'],
      date: '2026-04-11',
    });

    expect(second.storageBytesTotal).toBe(100);
  });

  it('preserves existing delta counters when snapshotting', async () => {
    const store = new InMemoryDailyDocStore();
    const storage = makeStorage({
      'originals/lib-1/photo-a/original.jpg': 100,
    });

    // Pre-existing rollup deltas
    await store.transact('tenant-A', '2026-04-12', (cur) => ({
      tenantId: 'tenant-A',
      date: '2026-04-12',
      storageBytesDelta: 42,
      imagesUploaded: 7,
      imagesProcessed: 0,
      signedUrlsIssued: 0,
      editsApplied: 0,
      apiCalls: 3,
      storageBytesTotal: null,
      appliedEventIds: [],
      updatedAt: new Date().toISOString(),
      ...(cur ?? {}),
    }));

    const doc = await snapshotTenantStorage('tenant-A', {
      storageAdapter: storage,
      store,
      resolveTenantLibraries: async () => ['lib-1'],
      date: '2026-04-12',
    });

    expect(doc.imagesUploaded).toBe(7);
    expect(doc.apiCalls).toBe(3);
    expect(doc.storageBytesDelta).toBe(42);
    expect(doc.storageBytesTotal).toBe(100);
  });

  it('emits a metering.rollup.completed event when an emitter is provided', async () => {
    const store = new InMemoryDailyDocStore();
    const storage = makeStorage({});
    const emitted: unknown[] = [];

    await snapshotTenantStorage('tenant-A', {
      storageAdapter: storage,
      store,
      resolveTenantLibraries: async () => [],
      date: '2026-04-13',
      emit: async (e) => {
        emitted.push(e);
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'metering.rollup.completed',
      tenantId: 'tenant-A',
      date: '2026-04-13',
      storageBytesTotal: 0,
    });
  });
});
