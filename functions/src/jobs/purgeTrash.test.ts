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
import { __resetTenantFeaturesCacheForTests } from '../services/host/tenantFeaturesConfigService.js';
import {
  TENANT_FEATURES_CONFIG_COLLECTION,
  type TenantFeaturesConfigRecord,
} from '../models/TenantFeaturesConfig.js';
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
    __resetTenantFeaturesCacheForTests();
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

  describe('per-tenant Trash retention override (issue #183)', () => {
    const now = new Date('2025-06-01T00:00:00Z');
    const day = 86_400_000;

    function storeTenantOverride(
      tenantId: string,
      retentionDays: number | null | undefined,
      extra: Partial<TenantFeaturesConfigRecord> = {}
    ) {
      const record: TenantFeaturesConfigRecord = {
        tenantId,
        flags: {},
        updatedAt: '2025-01-01T00:00:00Z',
        updatedBy: 'test',
        ...(retentionDays === undefined
          ? {}
          : { trashRetentionDays: retentionDays }),
        ...extra,
      };
      return data.storeData(
        TENANT_FEATURES_CONFIG_COLLECTION,
        tenantId,
        record
      );
    }

    it('uses the deployment default when the tenant has no config doc', async () => {
      // Photo is 20 days old; default is 30 → must NOT purge.
      await data.storeData('photos', 'p1', makePhoto({
        id: 'p1',
        tenantId: 'no-override',
        trashedAt: new Date(now.getTime() - 20 * day).toISOString(),
      }));
      const result = await runPurgeTrashJob({
        dataAdapter: data,
        usageBus: new InMemoryUsageMeteringBus(),
        retentionDays: 30,
        now: () => now,
      });
      expect(result.totalPurged).toBe(0);
      expect(await data.fetchData('photos', 'p1')).not.toBeNull();
    });

    it('honors a valid per-tenant override (Pro=7) and ignores the default', async () => {
      // Photo is 10 days old. Tenant override is 7 → must purge.
      await storeTenantOverride('pro-tenant', 7);
      await data.storeData('photos', 'pro-old', makePhoto({
        id: 'pro-old',
        tenantId: 'pro-tenant',
        trashedAt: new Date(now.getTime() - 10 * day).toISOString(),
      }));
      // Different tenant on default 30 with same age → must NOT purge.
      await data.storeData('photos', 'free-keep', makePhoto({
        id: 'free-keep',
        tenantId: 'free-tenant',
        trashedAt: new Date(now.getTime() - 10 * day).toISOString(),
      }));

      const result = await runPurgeTrashJob({
        dataAdapter: data,
        usageBus: new InMemoryUsageMeteringBus(),
        retentionDays: 30,
        now: () => now,
      });
      const purgedIds = result.tenants.flatMap((t) => t.purgedPhotoIds);
      expect(purgedIds).toContain('pro-old');
      expect(purgedIds).not.toContain('free-keep');
      expect(await data.fetchData('photos', 'pro-old')).toBeNull();
      expect(await data.fetchData('photos', 'free-keep')).not.toBeNull();
    });

    it('honors a higher per-tenant override (Business=90) and retains photos the deployment default would purge', async () => {
      // Photo is 60 days old. Default is 30 → would purge. Override=90 → keep.
      await storeTenantOverride('biz', 90);
      await data.storeData('photos', 'biz-keep', makePhoto({
        id: 'biz-keep',
        tenantId: 'biz',
        trashedAt: new Date(now.getTime() - 60 * day).toISOString(),
      }));
      // 100 day-old photo — even the override should purge this one.
      await data.storeData('photos', 'biz-purge', makePhoto({
        id: 'biz-purge',
        tenantId: 'biz',
        trashedAt: new Date(now.getTime() - 100 * day).toISOString(),
      }));

      const result = await runPurgeTrashJob({
        dataAdapter: data,
        usageBus: new InMemoryUsageMeteringBus(),
        retentionDays: 30,
        now: () => now,
      });
      expect(result.totalPurged).toBe(1);
      const purgedIds = result.tenants.flatMap((t) => t.purgedPhotoIds);
      expect(purgedIds).toEqual(['biz-purge']);
      expect(await data.fetchData('photos', 'biz-keep')).not.toBeNull();
      expect(await data.fetchData('photos', 'biz-purge')).toBeNull();
    });

    it('falls back to the deployment default on an invalid (out-of-range) override', async () => {
      // Store an invalid override (negative). Photo is 20 days old.
      // Override invalid → default 30 applies → must NOT purge.
      await storeTenantOverride('bad', -5);
      await data.storeData('photos', 'bad-photo', makePhoto({
        id: 'bad-photo',
        tenantId: 'bad',
        trashedAt: new Date(now.getTime() - 20 * day).toISOString(),
      }));

      const result = await runPurgeTrashJob({
        dataAdapter: data,
        usageBus: new InMemoryUsageMeteringBus(),
        retentionDays: 30,
        now: () => now,
      });
      expect(result.totalPurged).toBe(0);
      expect(await data.fetchData('photos', 'bad-photo')).not.toBeNull();
    });

    it('falls back to the deployment default on a non-integer override', async () => {
      // 3.7 days is not an integer → invalid → default applies.
      await storeTenantOverride('frac', 3.7);
      await data.storeData('photos', 'frac-keep', makePhoto({
        id: 'frac-keep',
        tenantId: 'frac',
        trashedAt: new Date(now.getTime() - 10 * day).toISOString(),
      }));

      const result = await runPurgeTrashJob({
        dataAdapter: data,
        usageBus: new InMemoryUsageMeteringBus(),
        retentionDays: 30,
        now: () => now,
      });
      expect(result.totalPurged).toBe(0);
      expect(await data.fetchData('photos', 'frac-keep')).not.toBeNull();
    });

    it('treats null trashRetentionDays as "no override" and uses the deployment default', async () => {
      await storeTenantOverride('nullish', null);
      await data.storeData('photos', 'nullish-old', makePhoto({
        id: 'nullish-old',
        tenantId: 'nullish',
        trashedAt: new Date(now.getTime() - 40 * day).toISOString(),
      }));

      const result = await runPurgeTrashJob({
        dataAdapter: data,
        usageBus: new InMemoryUsageMeteringBus(),
        retentionDays: 30,
        now: () => now,
      });
      // 40 days old — default 30 purges it.
      expect(result.totalPurged).toBe(1);
      expect(await data.fetchData('photos', 'nullish-old')).toBeNull();
    });

    it('disablePerTenantOverride forces the deployment default for every tenant', async () => {
      // Override would keep this photo (override=90) but the diagnostic
      // flag disables that resolution — default 30 must apply.
      await storeTenantOverride('biz', 90);
      await data.storeData('photos', 'biz-photo', makePhoto({
        id: 'biz-photo',
        tenantId: 'biz',
        trashedAt: new Date(now.getTime() - 60 * day).toISOString(),
      }));

      const result = await runPurgeTrashJob({
        dataAdapter: data,
        usageBus: new InMemoryUsageMeteringBus(),
        retentionDays: 30,
        now: () => now,
        disablePerTenantOverride: true,
      });
      expect(result.totalPurged).toBe(1);
      expect(await data.fetchData('photos', 'biz-photo')).toBeNull();
    });
  });
});
