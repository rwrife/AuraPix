import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runPurgeTrashJob, resolveTrashRetentionDays, DEFAULT_TRASH_RETENTION_DAYS } from './purgeTrash.js';
import type { DataAdapter, QueryFilter } from '../adapters/data/DataAdapter.js';
import {
  setMeteringBus,
  setWebhookDeliveryStore,
} from '../services/metering/index.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../services/metering/MeteringBus.js';
import { InMemoryUsageMeteringBus } from '../services/metering/UsageMeteringBus.js';
import type { Photo } from '../models/Photo.js';

class InMemoryData implements DataAdapter {
  public docs = new Map<string, Map<string, any>>();
  private col(c: string) {
    let m = this.docs.get(c);
    if (!m) { m = new Map(); this.docs.set(c, m); }
    return m;
  }
  async storeData(c: string, id: string, d: any) { this.col(c).set(id, d); }
  async fetchData(c: string, id: string) { return this.col(c).get(id) ?? null; }
  async queryData(c: string, filters: QueryFilter[]) {
    return Array.from(this.col(c).values()).filter((d) =>
      filters.every((f) => (d as any)[f.field] === f.value)
    );
  }
  async updateData(c: string, id: string, u: any) {
    const cur = this.col(c).get(id);
    this.col(c).set(id, { ...cur, ...u });
  }
  async deleteData(c: string, id: string) { this.col(c).delete(id); }
  async exists(c: string, id: string) { return this.col(c).has(id); }
  async listIds(c: string) { return Array.from(this.col(c).keys()); }
  async getPhoto() { return null; }
}

class CapturingSink implements MeteringSink {
  batches: NormalizedMeteringEvent[][] = [];
  async deliver(events: NormalizedMeteringEvent[]) { this.batches.push(events); }
  all() { return this.batches.flat(); }
}

function makePhoto(p: Partial<Photo> = {}): Photo {
  return {
    id: 'p',
    libraryId: 'lib',
    tenantId: 'acme',
    albumIds: [],
    originalName: 'x.jpg',
    storagePaths: {
      original: 'o/x.jpg',
      derivatives: {
        small_webp: '',
        small_jpeg: '',
        medium_webp: '',
        medium_jpeg: '',
        large_webp: '',
        large_jpeg: '',
        preview_jpeg: '',
      },
    },
    metadata: { width: 1, height: 1, mimeType: 'image/jpeg', sizeBytes: 500 },
    status: 'ready',
    currentEditVersion: 0,
    editHistory: [],
    thumbnailsOutdated: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    trashedAt: null,
    trashedBy: null,
    ...p,
  };
}

describe('purgeTrash job', () => {
  let data: InMemoryData;
  let sink: CapturingSink;

  beforeEach(() => {
    data = new InMemoryData();
    sink = new CapturingSink();
    setWebhookDeliveryStore(null);
    setMeteringBus(new MeteringBus({ sink, flushIntervalMs: 10, maxBatchSize: 50 }));
  });

  afterEach(() => {
    setMeteringBus(null);
  });

  it('purges photos older than retention with fake clock', async () => {
    const now = new Date('2025-06-01T00:00:00Z');
    const day = 86_400_000;
    await data.storeData('photos', 'old', makePhoto({
      id: 'old', trashedAt: new Date(now.getTime() - 40 * day).toISOString(),
    }));
    await data.storeData('photos', 'fresh', makePhoto({
      id: 'fresh', trashedAt: new Date(now.getTime() - 10 * day).toISOString(),
    }));

    const usageBus = new InMemoryUsageMeteringBus();
    const result = await runPurgeTrashJob({
      dataAdapter: data,
      usageBus,
      retentionDays: 30,
      now: () => now,
    });

    expect(result.totalPurged).toBe(1);
    expect(result.tenants[0]!.purgedPhotoIds).toEqual(['old']);
    expect(await data.fetchData('photos', 'old')).toBeNull();
    expect(await data.fetchData('photos', 'fresh')).not.toBeNull();
  });

  it('default retention is 30 days when env unset', () => {
    expect(resolveTrashRetentionDays({})).toBe(DEFAULT_TRASH_RETENTION_DAYS);
  });

  it('reads TRASH_RETENTION_DAYS env override', () => {
    expect(resolveTrashRetentionDays({ TRASH_RETENTION_DAYS: '7' })).toBe(7);
  });

  it('falls back to default on garbage env value', () => {
    expect(resolveTrashRetentionDays({ TRASH_RETENTION_DAYS: 'banana' })).toBe(
      DEFAULT_TRASH_RETENTION_DAYS
    );
  });
});
