import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { DataAdapter, QueryFilter } from '../../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import {
  PhotosService,
  PhotoNotFoundError,
  collectStoragePaths,
} from './PhotosService.js';
import { CrossTenantAccessError } from '../tenant/Tenant.js';
import {
  setMeteringBus,
  setWebhookDeliveryStore,
} from '../../services/metering/index.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../../services/metering/MeteringBus.js';
import { InMemoryUsageMeteringBus } from '../../services/metering/UsageMeteringBus.js';
import type { Photo } from '../../models/Photo.js';

class InMemoryData implements DataAdapter {
  public docs = new Map<string, Map<string, any>>();
  private col(c: string) {
    let m = this.docs.get(c);
    if (!m) {
      m = new Map();
      this.docs.set(c, m);
    }
    return m;
  }
  async storeData<T>(c: string, id: string, data: T) { this.col(c).set(id, data); }
  async fetchData<T>(c: string, id: string) {
    return (this.col(c).get(id) as T) ?? null;
  }
  async queryData<T>(c: string, filters: QueryFilter[]): Promise<T[]> {
    const all = Array.from(this.col(c).values()) as T[];
    return all.filter((d) =>
      filters.every((f) => {
        const v = (d as any)[f.field];
        switch (f.operator) {
          case '==': return v === f.value;
          case '!=': return v !== f.value;
          case '>': return v > f.value;
          case '>=': return v >= f.value;
          case '<': return v < f.value;
          case '<=': return v <= f.value;
          default: return false;
        }
      })
    );
  }
  async updateData<T>(c: string, id: string, updates: Partial<T>) {
    const cur = this.col(c).get(id);
    if (!cur) throw new Error('not found');
    this.col(c).set(id, { ...cur, ...updates });
  }
  async deleteData(c: string, id: string) { this.col(c).delete(id); }
  async exists(c: string, id: string) { return this.col(c).has(id); }
  async listIds(c: string) { return Array.from(this.col(c).keys()); }
  async getPhoto() { return null; }
}

class CapturingStorage implements StorageAdapter {
  public deleted: string[] = [];
  public failPaths = new Set<string>();
  async storeFile() {}
  async readFile() { return Buffer.alloc(0); }
  async fileExists() { return true; }
  async deleteFile(p: string) {
    if (this.failPaths.has(p)) throw new Error('boom');
    this.deleted.push(p);
  }
  async listFiles() { return []; }
  async getFileSize() { return 0; }
}

class CapturingSink implements MeteringSink {
  batches: NormalizedMeteringEvent[][] = [];
  async deliver(events: NormalizedMeteringEvent[]) {
    this.batches.push(events);
  }
  all(): NormalizedMeteringEvent[] {
    return this.batches.flat();
  }
}

function makePhoto(overrides: Partial<Photo> = {}): Photo {
  const now = new Date('2025-01-01T00:00:00Z').toISOString();
  return {
    id: overrides.id ?? 'p1',
    libraryId: overrides.libraryId ?? 'lib1',
    tenantId: overrides.tenantId ?? 'acme',
    albumIds: [],
    originalName: 'a.jpg',
    storagePaths: {
      original: 'orig/p1.jpg',
      derivatives: {
        small_webp: 'd/p1.s.webp',
        small_jpeg: 'd/p1.s.jpg',
        medium_webp: 'd/p1.m.webp',
        medium_jpeg: 'd/p1.m.jpg',
        large_webp: 'd/p1.l.webp',
        large_jpeg: 'd/p1.l.jpg',
        preview_jpeg: 'd/p1.p.jpg',
      },
    },
    metadata: {
      width: 100,
      height: 100,
      mimeType: 'image/jpeg',
      sizeBytes: 1000,
    },
    status: 'ready',
    currentEditVersion: 0,
    editHistory: [],
    thumbnailsOutdated: false,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashedBy: null,
    ...overrides,
  };
}

describe('PhotosService', () => {
  let data: InMemoryData;
  let sink: CapturingSink;

  beforeEach(() => {
    data = new InMemoryData();
    sink = new CapturingSink();
    setWebhookDeliveryStore(null); // reset metering wiring
    setMeteringBus(new MeteringBus({ sink, flushIntervalMs: 10, maxBatchSize: 50 }));
  });

  afterEach(() => {
    setMeteringBus(null);
  });

  it('soft-delete sets trashedAt and emits photo.trashed', async () => {
    await data.storeData('photos', 'p1', makePhoto());
    const svc = new PhotosService({ dataAdapter: data });

    const out = await svc.softDelete('p1', 'acme', 'user-7');
    expect(out.trashedAt).toBeTruthy();
    expect(out.trashedBy).toBe('user-7');

    // Force flush by waiting
    await new Promise((r) => setTimeout(r, 30));
    const events = sink.all();
    expect(events.some((e) => e.type === 'photo.trashed' && e.resourceId === 'p1')).toBe(true);
  });

  it('soft-delete is idempotent', async () => {
    await data.storeData('photos', 'p1', makePhoto({ trashedAt: '2025-01-01T00:00:00Z' }));
    const svc = new PhotosService({ dataAdapter: data });
    const out = await svc.softDelete('p1', 'acme', 'user-1');
    expect(out.trashedAt).toBe('2025-01-01T00:00:00Z');
  });

  it('restore clears trashedAt', async () => {
    await data.storeData('photos', 'p1', makePhoto({ trashedAt: '2025-01-01T00:00:00Z', trashedBy: 'u' }));
    const svc = new PhotosService({ dataAdapter: data });
    const out = await svc.restore('p1', 'acme');
    expect(out.trashedAt).toBeNull();
    expect(out.trashedBy).toBeNull();
  });

  it('cross-tenant restore returns 403 (CrossTenantAccessError)', async () => {
    await data.storeData('photos', 'p1', makePhoto({ tenantId: 'acme', trashedAt: '2025-01-01T00:00:00Z' }));
    const svc = new PhotosService({ dataAdapter: data });
    await expect(svc.restore('p1', 'globex')).rejects.toBeInstanceOf(CrossTenantAccessError);
  });

  it('missing photo throws PhotoNotFoundError', async () => {
    const svc = new PhotosService({ dataAdapter: data });
    await expect(svc.softDelete('missing', 'acme', null)).rejects.toBeInstanceOf(PhotoNotFoundError);
  });

  it('list hides trashed by default; returns only trash when trashed=true', async () => {
    await data.storeData('photos', 'a', makePhoto({ id: 'a' }));
    await data.storeData('photos', 'b', makePhoto({ id: 'b', trashedAt: '2025-01-01T00:00:00Z' }));
    const svc = new PhotosService({ dataAdapter: data });

    const active = await svc.list('acme');
    expect(active.map((p) => p.id)).toEqual(['a']);

    const trashed = await svc.list('acme', { trashed: true });
    expect(trashed.map((p) => p.id)).toEqual(['b']);
  });

  it('list is tenant-scoped', async () => {
    await data.storeData('photos', 'a', makePhoto({ id: 'a', tenantId: 'acme' }));
    await data.storeData('photos', 'c', makePhoto({ id: 'c', tenantId: 'globex' }));
    const svc = new PhotosService({ dataAdapter: data });
    const active = await svc.list('acme');
    expect(active.map((p) => p.id)).toEqual(['a']);
  });

  describe('purgeExpired (fake clock)', () => {
    it('only purges items older than retention; emits photo.purged once each', async () => {
      // p1 trashed 40 days ago, p2 trashed 5 days ago, retention=30d
      const now = new Date('2025-06-01T00:00:00Z');
      const dayMs = 24 * 60 * 60 * 1000;
      await data.storeData('photos', 'p1', makePhoto({
        id: 'p1',
        trashedAt: new Date(now.getTime() - 40 * dayMs).toISOString(),
      }));
      await data.storeData('photos', 'p2', makePhoto({
        id: 'p2',
        trashedAt: new Date(now.getTime() - 5 * dayMs).toISOString(),
      }));
      await data.storeData('photos', 'p3', makePhoto({
        id: 'p3', // not trashed
      }));

      const storage = new CapturingStorage();
      const usageBus = new InMemoryUsageMeteringBus();
      const rollupEvents: any[] = [];
      usageBus.subscribe((e) => { rollupEvents.push(e); });

      const svc = new PhotosService({
        dataAdapter: data,
        storageAdapter: storage,
        usageBus,
        now: () => now,
      });

      const results = await svc.purgeExpired({ retentionDays: 30 });
      expect(results).toHaveLength(1);
      expect(results[0]!.photoIds).toEqual(['p1']);

      // Doc removed for purged photo only.
      expect(await data.fetchData('photos', 'p1')).toBeNull();
      expect(await data.fetchData('photos', 'p2')).not.toBeNull();
      expect(await data.fetchData('photos', 'p3')).not.toBeNull();

      // Storage cleanup happened.
      expect(storage.deleted).toContain('orig/p1.jpg');

      // photo.purged emitted exactly once.
      await new Promise((r) => setTimeout(r, 30));
      const purgedEvents = sink.all().filter((e) => e.type === 'photo.purged');
      expect(purgedEvents).toHaveLength(1);
      expect(purgedEvents[0]!.resourceId).toBe('p1');
      expect(purgedEvents[0]!.bytes).toBe(-1000);

      // storageBytesDelta rollup decrements (not on trash).
      expect(rollupEvents).toHaveLength(1);
      expect(rollupEvents[0]!.counter).toBe('storageBytesDelta');
      expect(rollupEvents[0]!.value).toBe(-1000);
      expect(rollupEvents[0]!.eventId).toBe('photo.purged:p1');
    });

    it('iterates per-tenant so one tenant cannot starve others', async () => {
      const now = new Date('2025-06-01T00:00:00Z');
      const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

      // Tenant "noisy" has many trashed photos; tenant "quiet" has one.
      for (let i = 0; i < 5; i++) {
        await data.storeData('photos', `n${i}`, makePhoto({
          id: `n${i}`, tenantId: 'noisy', trashedAt: old,
        }));
      }
      await data.storeData('photos', 'q1', makePhoto({
        id: 'q1', tenantId: 'quiet', trashedAt: old,
      }));

      const svc = new PhotosService({
        dataAdapter: data,
        now: () => now,
      });

      const results = await svc.purgeExpired({ retentionDays: 30, perTenantLimit: 2 });
      const byTenant = Object.fromEntries(
        results.map((r) => [r.tenantId, r.photoIds.length])
      );
      // noisy capped at 2, quiet still gets its 1 in the same run.
      expect(byTenant.noisy).toBe(2);
      expect(byTenant.quiet).toBe(1);
    });
  });
});

describe('PhotosService tag mutation (issue #173)', () => {
  let data: InMemoryData;
  let sink: CapturingSink;
  let usageBus: InMemoryUsageMeteringBus;
  let usageEvents: Array<{
    tenantId: string;
    counter: string;
    value: number;
  }>;

  beforeEach(() => {
    data = new InMemoryData();
    sink = new CapturingSink();
    usageBus = new InMemoryUsageMeteringBus();
    usageEvents = [];
    usageBus.subscribe(async (e) => {
      usageEvents.push({
        tenantId: e.tenantId,
        counter: e.counter,
        value: e.value,
      });
    });
    setWebhookDeliveryStore(null);
    setMeteringBus(new MeteringBus({ sink, flushIntervalMs: 10, maxBatchSize: 50 }));
  });

  afterEach(() => {
    setMeteringBus(null);
  });

  it('adds new tags, emits one photo.tagged event, increments tagsApplied', async () => {
    const svc = new PhotosService({ dataAdapter: data, usageBus });
    const p = makePhoto({ id: 't1', tags: ['wedding'] });
    await data.storeData('photos', p.id, p);

    const { photo, mutation } = await svc.updateTags(
      't1',
      'acme',
      'user-1',
      { add: ['Wedding', 'print-ready', 'client:smith'] }
    );

    expect(photo.tags).toEqual(['wedding', 'print-ready', 'client:smith']);
    expect(mutation.added).toBe(2); // 'wedding' was already present
    expect(mutation.removed).toBe(0);
    expect(mutation.changed).toBe(true);

    // Flush the metering bus to deliver events to the sink.
    await new Promise((r) => setTimeout(r, 20));
    const events = sink.all().filter((e) => e.type === 'photo.tagged');
    expect(events).toHaveLength(1); // one per mutation, not per tag
    expect(events[0]!.meta).toMatchObject({
      libraryId: 'lib1',
      actor: 'user-1',
      added: 2,
      removed: 0,
    });

    // tagsApplied counter increments by added+removed = 2.
    await new Promise((r) => setTimeout(r, 5));
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      tenantId: 'acme',
      counter: 'tagsApplied',
      value: 2,
    });
  });

  it('is a no-op when add/remove yields no change (no write, no event)', async () => {
    const svc = new PhotosService({ dataAdapter: data, usageBus });
    const p = makePhoto({ id: 't2', tags: ['wedding'] });
    await data.storeData('photos', p.id, p);
    const before = await data.fetchData<Photo>('photos', 't2');

    const { mutation } = await svc.updateTags('t2', 'acme', null, {
      add: ['wedding'], // already present
      remove: ['nope'], // absent
    });

    expect(mutation.changed).toBe(false);
    expect(mutation.added).toBe(0);
    expect(mutation.removed).toBe(0);

    const after = await data.fetchData<Photo>('photos', 't2');
    expect(after).toEqual(before); // no write occurred

    await new Promise((r) => setTimeout(r, 20));
    expect(sink.all().filter((e) => e.type === 'photo.tagged')).toHaveLength(0);
    expect(usageEvents).toHaveLength(0);
  });

  it('removes tags and reports removed count', async () => {
    const svc = new PhotosService({ dataAdapter: data, usageBus });
    const p = makePhoto({ id: 't3', tags: ['wedding', 'draft', 'print-ready'] });
    await data.storeData('photos', p.id, p);

    const { photo, mutation } = await svc.updateTags(
      't3',
      'acme',
      'user-2',
      { remove: ['draft', 'Print-Ready'] }
    );

    expect(photo.tags).toEqual(['wedding']);
    expect(mutation.removed).toBe(2);
    expect(mutation.added).toBe(0);
  });

  it('rejects cross-tenant tag mutation with CrossTenantAccessError', async () => {
    const svc = new PhotosService({ dataAdapter: data });
    const p = makePhoto({ id: 't4', tenantId: 'acme' });
    await data.storeData('photos', p.id, p);

    await expect(
      svc.updateTags('t4', 'other-tenant', null, { add: ['x'] })
    ).rejects.toBeInstanceOf(CrossTenantAccessError);
  });

  it('throws PhotoNotFoundError for unknown ids', async () => {
    const svc = new PhotosService({ dataAdapter: data });
    await expect(
      svc.updateTags('missing', 'acme', null, { add: ['x'] })
    ).rejects.toBeInstanceOf(PhotoNotFoundError);
  });

  it('list filters by tags with AND semantics', async () => {
    const svc = new PhotosService({ dataAdapter: data });
    await data.storeData('photos', 'a', makePhoto({ id: 'a', tags: ['wedding', 'print-ready'] }));
    await data.storeData('photos', 'b', makePhoto({ id: 'b', tags: ['wedding'] }));
    await data.storeData('photos', 'c', makePhoto({ id: 'c', tags: ['print-ready'] }));
    await data.storeData('photos', 'd', makePhoto({ id: 'd', tags: [] }));

    const both = await svc.list('acme', { tags: ['wedding', 'print-ready'] });
    expect(both.map((p) => p.id).sort()).toEqual(['a']);

    const wedding = await svc.list('acme', { tags: ['wedding'] });
    expect(wedding.map((p) => p.id).sort()).toEqual(['a', 'b']);

    const none = await svc.list('acme', { tags: [] });
    expect(none).toHaveLength(4); // empty filter → no narrowing
  });

  it('listLibraryTags returns counts scoped to the library, sorted by count desc', async () => {
    const svc = new PhotosService({ dataAdapter: data });
    await data.storeData('photos', 'a', makePhoto({ id: 'a', libraryId: 'lib1', tags: ['wedding', 'print-ready'] }));
    await data.storeData('photos', 'b', makePhoto({ id: 'b', libraryId: 'lib1', tags: ['wedding'] }));
    await data.storeData('photos', 'c', makePhoto({ id: 'c', libraryId: 'lib2', tags: ['wedding', 'foo'] }));
    // Trashed photo should not contribute to counts.
    await data.storeData('photos', 'd', makePhoto({
      id: 'd',
      libraryId: 'lib1',
      tags: ['wedding'],
      trashedAt: new Date().toISOString(),
    }));

    const lib1Tags = await svc.listLibraryTags('lib1', 'acme');
    expect(lib1Tags).toEqual([
      { tag: 'wedding', count: 2 },
      { tag: 'print-ready', count: 1 },
    ]);

    const lib2Tags = await svc.listLibraryTags('lib2', 'acme');
    expect(lib2Tags).toEqual([
      { tag: 'foo', count: 1 },
      { tag: 'wedding', count: 1 },
    ]);
  });

  it('cross-tenant listLibraryTags returns empty (tenant scoping prevents leakage)', async () => {
    const svc = new PhotosService({ dataAdapter: data });
    await data.storeData('photos', 'a', makePhoto({ id: 'a', tenantId: 'acme', libraryId: 'lib1', tags: ['wedding'] }));

    const result = await svc.listLibraryTags('lib1', 'other-tenant');
    expect(result).toEqual([]);
  });
});

describe('collectStoragePaths', () => {
  it('includes original + every derivative', () => {
    const p = makePhoto();
    const paths = collectStoragePaths(p);
    expect(paths).toContain('orig/p1.jpg');
    expect(paths).toContain('d/p1.p.jpg');
    expect(paths.length).toBeGreaterThanOrEqual(8);
  });

  it('handles legacy single storagePath', () => {
    const p = makePhoto({ storagePaths: undefined, storagePath: 'legacy/p1.jpg' });
    expect(collectStoragePaths(p)).toEqual(['legacy/p1.jpg']);
  });
});
