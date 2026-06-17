import { describe, it, expect, beforeEach } from 'vitest';
import type { DataAdapter, QueryFilter } from '../../adapters/data/DataAdapter.js';
import {
  SmartAlbumsService,
  SmartAlbumNotFoundError,
  SmartAlbumsCapExceededError,
  SmartAlbumValidationError,
} from './SmartAlbumsService.js';
import { InMemorySmartAlbumRepository } from '../../adapters/domain/in-memory/InMemorySmartAlbumRepository.js';
import { CrossTenantAccessError } from '../tenant/Tenant.js';
import type { Photo } from '../../models/Photo.js';
import {
  setMeteringBus,
} from '../../services/metering/index.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../../services/metering/MeteringBus.js';

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
    id: 'photo-1',
    libraryId: 'lib-1',
    tenantId: 'tenant-a',
    albumIds: [],
    originalName: 'photo.jpg',
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
    ...overrides,
  };
}

function buildService(opts: { cap?: number } = {}) {
  const repo = new InMemorySmartAlbumRepository();
  const data = new InMemoryData();
  const sink = new CapturingSink();
  const bus = new MeteringBus({ sink, flushIntervalMs: 1, maxBatchSize: 1 });
  setMeteringBus(bus);
  const service = new SmartAlbumsService({
    repo,
    dataAdapter: data,
    cap: opts.cap,
  });
  return { service, repo, data, sink };
}

describe('SmartAlbumsService — filter validation', () => {
  beforeEach(() => setMeteringBus(null));

  it('rejects unknown filter keys', async () => {
    const { service } = buildService();
    await expect(
      service.create({
        libraryId: 'lib-1',
        ownerId: 'u',
        tenantId: 'tenant-a',
        name: 'My filter',
        filter: { evilKey: 'x' } as unknown,
      })
    ).rejects.toThrow(SmartAlbumValidationError);
  });

  it('rejects out-of-range rating', async () => {
    const { service } = buildService();
    await expect(
      service.create({
        libraryId: 'lib-1',
        ownerId: 'u',
        tenantId: 'tenant-a',
        name: 'My filter',
        filter: { rating: { gte: 9 } },
      })
    ).rejects.toThrow(SmartAlbumValidationError);
  });

  it('rejects rating where gte > lte', async () => {
    const { service } = buildService();
    await expect(
      service.create({
        libraryId: 'lib-1',
        ownerId: 'u',
        tenantId: 'tenant-a',
        name: 'My filter',
        filter: { rating: { gte: 4, lte: 2 } },
      })
    ).rejects.toThrow(SmartAlbumValidationError);
  });

  it('rejects empty name', async () => {
    const { service } = buildService();
    await expect(
      service.create({
        libraryId: 'lib-1',
        ownerId: 'u',
        tenantId: 'tenant-a',
        name: '   ',
        filter: {},
      })
    ).rejects.toThrow(SmartAlbumValidationError);
  });

  it('accepts valid filter and emits smart_album.created', async () => {
    const { service, sink } = buildService();
    const created = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: '5-stars',
      filter: { rating: { gte: 5 } },
    });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.tenantId).toBe('tenant-a');
    expect(created.filter).toEqual({ rating: { gte: 5 } });

    // metering bus flushes by interval; force-flush by waiting
    await new Promise((r) => setTimeout(r, 10));
    const events = sink.all();
    expect(events.some((e) => e.type === 'smart_album.created')).toBe(true);
  });
});

describe('SmartAlbumsService — tenant isolation', () => {
  beforeEach(() => setMeteringBus(null));

  it('list filters cross-tenant rows', async () => {
    const { service } = buildService();
    await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'A',
      filter: {},
    });
    await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-b',
      name: 'B',
      filter: {},
    });
    const aList = await service.list('tenant-a', 'lib-1');
    expect(aList.map((s) => s.name)).toEqual(['A']);
  });

  it('throws CrossTenantAccessError on cross-tenant get', async () => {
    const { service } = buildService();
    const created = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'A',
      filter: {},
    });
    await expect(service.get(created.id, 'tenant-b')).rejects.toThrow(
      CrossTenantAccessError
    );
  });

  it('throws CrossTenantAccessError on cross-tenant delete', async () => {
    const { service } = buildService();
    const created = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'A',
      filter: {},
    });
    await expect(service.remove(created.id, 'tenant-b')).rejects.toThrow(
      CrossTenantAccessError
    );
  });
});

describe('SmartAlbumsService — cap', () => {
  beforeEach(() => setMeteringBus(null));

  it('rejects creation past per-library cap', async () => {
    const { service } = buildService({ cap: 2 });
    await service.create({ libraryId: 'lib-1', ownerId: 'u', tenantId: 'tenant-a', name: 'a', filter: {} });
    await service.create({ libraryId: 'lib-1', ownerId: 'u', tenantId: 'tenant-a', name: 'b', filter: {} });
    await expect(
      service.create({ libraryId: 'lib-1', ownerId: 'u', tenantId: 'tenant-a', name: 'c', filter: {} })
    ).rejects.toThrow(SmartAlbumsCapExceededError);
  });

  it('cap is per-(tenant, library); other libraries unaffected', async () => {
    const { service } = buildService({ cap: 1 });
    await service.create({ libraryId: 'lib-1', ownerId: 'u', tenantId: 'tenant-a', name: 'a', filter: {} });
    // Different library: allowed.
    await expect(
      service.create({ libraryId: 'lib-2', ownerId: 'u', tenantId: 'tenant-a', name: 'b', filter: {} })
    ).resolves.toBeTruthy();
    // Different tenant: allowed.
    await expect(
      service.create({ libraryId: 'lib-1', ownerId: 'u', tenantId: 'tenant-b', name: 'c', filter: {} })
    ).resolves.toBeTruthy();
  });
});

describe('SmartAlbumsService — materialize', () => {
  beforeEach(() => setMeteringBus(null));

  it('returns empty when there are no photos', async () => {
    const { service } = buildService();
    const album = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'all',
      filter: {},
    });
    const result = await service.materialize(album.id, 'tenant-a');
    expect(result.photos).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.nextPageToken).toBeNull();
  });

  it('matches photos by rating gte/lte', async () => {
    const { service, data } = buildService();
    data.docs.set(
      'photos',
      new Map([
        ['p1', { ...makePhoto({ id: 'p1' }), rating: 5 }],
        ['p2', { ...makePhoto({ id: 'p2' }), rating: 3 }],
        ['p3', { ...makePhoto({ id: 'p3' }), rating: 1 }],
      ])
    );
    const album = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'four-or-up',
      filter: { rating: { gte: 4 } },
    });
    const result = await service.materialize(album.id, 'tenant-a');
    expect(result.photos.map((p) => p.id)).toEqual(['p1']);
    expect(result.total).toBe(1);
  });

  it('matches photos by flag', async () => {
    const { service, data } = buildService();
    data.docs.set(
      'photos',
      new Map([
        ['p1', { ...makePhoto({ id: 'p1' }), flag: 'pick' }],
        ['p2', { ...makePhoto({ id: 'p2' }), flag: 'reject' }],
      ])
    );
    const album = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'picks',
      filter: { flag: 'pick' },
    });
    const result = await service.materialize(album.id, 'tenant-a');
    expect(result.photos.map((p) => p.id)).toEqual(['p1']);
  });

  it('matches photos by tags (any-of)', async () => {
    const { service, data } = buildService();
    data.docs.set(
      'photos',
      new Map([
        ['p1', { ...makePhoto({ id: 'p1' }), tags: ['family', '2026'] }],
        ['p2', { ...makePhoto({ id: 'p2' }), tags: ['work'] }],
        ['p3', { ...makePhoto({ id: 'p3' }) }],
      ])
    );
    const album = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'family',
      filter: { tags: ['family'] },
    });
    const result = await service.materialize(album.id, 'tenant-a');
    expect(result.photos.map((p) => p.id)).toEqual(['p1']);
  });

  it('matches photos by capturedBetween (inclusive)', async () => {
    const { service, data } = buildService();
    const inside = '2026-06-15T10:00:00Z';
    const outside = '2025-01-01T10:00:00Z';
    data.docs.set(
      'photos',
      new Map([
        [
          'p1',
          makePhoto({
            id: 'p1',
            metadata: {
              width: 1,
              height: 1,
              mimeType: 'image/jpeg',
              sizeBytes: 1,
              takenAt: inside,
            },
          }),
        ],
        [
          'p2',
          makePhoto({
            id: 'p2',
            metadata: {
              width: 1,
              height: 1,
              mimeType: 'image/jpeg',
              sizeBytes: 1,
              takenAt: outside,
            },
          }),
        ],
      ])
    );
    const album = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: '2026',
      filter: {
        capturedBetween: ['2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z'],
      },
    });
    const result = await service.materialize(album.id, 'tenant-a');
    expect(result.photos.map((p) => p.id)).toEqual(['p1']);
  });

  it('matches photos by mimeTypes', async () => {
    const { service, data } = buildService();
    data.docs.set(
      'photos',
      new Map([
        [
          'p1',
          makePhoto({
            id: 'p1',
            metadata: { width: 1, height: 1, mimeType: 'image/heic', sizeBytes: 1 },
          }),
        ],
        [
          'p2',
          makePhoto({
            id: 'p2',
            metadata: { width: 1, height: 1, mimeType: 'image/jpeg', sizeBytes: 1 },
          }),
        ],
      ])
    );
    const album = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'heic',
      filter: { mimeTypes: ['image/heic'] },
    });
    const result = await service.materialize(album.id, 'tenant-a');
    expect(result.photos.map((p) => p.id)).toEqual(['p1']);
  });

  it('hides trashed photos', async () => {
    const { service, data } = buildService();
    data.docs.set(
      'photos',
      new Map([
        ['p1', makePhoto({ id: 'p1' })],
        [
          'p2',
          makePhoto({ id: 'p2', trashedAt: '2025-02-01T00:00:00Z', trashedBy: 'u' }),
        ],
      ])
    );
    const album = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'all',
      filter: {},
    });
    const result = await service.materialize(album.id, 'tenant-a');
    expect(result.photos.map((p) => p.id)).toEqual(['p1']);
  });

  it('does not return photos from another tenant', async () => {
    const { service, data } = buildService();
    data.docs.set(
      'photos',
      new Map([
        ['p1', makePhoto({ id: 'p1', tenantId: 'tenant-a' })],
        ['p2', makePhoto({ id: 'p2', tenantId: 'tenant-b' })],
      ])
    );
    const album = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'all',
      filter: {},
    });
    const result = await service.materialize(album.id, 'tenant-a');
    expect(result.photos.map((p) => p.id)).toEqual(['p1']);
  });

  it('paginates with stable pageToken', async () => {
    const { service, data } = buildService();
    const photos = new Map<string, Photo>();
    for (let i = 0; i < 5; i++) {
      photos.set(
        `p${i}`,
        makePhoto({
          id: `p${i}`,
          updatedAt: `2025-01-0${i + 1}T00:00:00Z`,
        })
      );
    }
    data.docs.set('photos', photos);
    const album = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'all',
      filter: {},
    });
    const page1 = await service.materialize(album.id, 'tenant-a', { pageSize: 2 });
    expect(page1.photos).toHaveLength(2);
    expect(page1.nextPageToken).not.toBeNull();
    expect(page1.total).toBe(5);

    const page2 = await service.materialize(album.id, 'tenant-a', {
      pageSize: 2,
      pageToken: page1.nextPageToken,
    });
    expect(page2.photos).toHaveLength(2);
    expect(page2.nextPageToken).not.toBeNull();

    const page3 = await service.materialize(album.id, 'tenant-a', {
      pageSize: 2,
      pageToken: page2.nextPageToken,
    });
    expect(page3.photos).toHaveLength(1);
    expect(page3.nextPageToken).toBeNull();

    // No duplicates across pages.
    const ids = [...page1.photos, ...page2.photos, ...page3.photos].map((p) => p.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('throws SmartAlbumNotFoundError for unknown id', async () => {
    const { service } = buildService();
    await expect(service.materialize('missing', 'tenant-a')).rejects.toThrow(
      SmartAlbumNotFoundError
    );
  });
});

describe('SmartAlbumsService — update / delete', () => {
  beforeEach(() => setMeteringBus(null));

  it('updates name and filter', async () => {
    const { service } = buildService();
    const created = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'A',
      filter: {},
    });
    const updated = await service.update(created.id, 'tenant-a', {
      name: 'A (renamed)',
      filter: { flag: 'pick' },
    });
    expect(updated.name).toBe('A (renamed)');
    expect(updated.filter).toEqual({ flag: 'pick' });
  });

  it('rejects update with unknown filter key', async () => {
    const { service } = buildService();
    const created = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'A',
      filter: {},
    });
    await expect(
      service.update(created.id, 'tenant-a', {
        filter: { whatever: 1 },
      })
    ).rejects.toThrow(SmartAlbumValidationError);
  });

  it('emits smart_album.deleted on remove', async () => {
    const { service, sink } = buildService();
    const created = await service.create({
      libraryId: 'lib-1',
      ownerId: 'u',
      tenantId: 'tenant-a',
      name: 'A',
      filter: {},
    });
    await service.remove(created.id, 'tenant-a');
    await new Promise((r) => setTimeout(r, 10));
    const types = sink.all().map((e) => e.type);
    expect(types).toContain('smart_album.deleted');
  });
});
