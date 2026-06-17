/**
 * Tests for the TenantOffboardingService (issue #155).
 *
 * Covers:
 *  - export request emits `tenant.export.requested` then `tenant.export.completed`
 *  - export manifest contains the seeded tenant's photo/album metadata
 *  - getExport returns null for a foreign tenantId
 *  - delete sweep removes all tenant data and emits `tenant.deleted` once
 *  - resuming a completed delete does not re-emit events
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DataAdapter, QueryFilter } from '../../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import {
  TenantOffboardingService,
  TENANT_PARTITIONED_COLLECTIONS,
} from './TenantOffboardingService.js';
import {
  MeteringBus,
  type NormalizedMeteringEvent,
} from '../metering/MeteringBus.js';
import { setMeteringBus } from '../metering/index.js';

class MemData implements DataAdapter {
  collections: Map<string, Map<string, any>> = new Map();
  async storeData<T>(c: string, id: string, data: T): Promise<void> {
    if (!this.collections.has(c)) this.collections.set(c, new Map());
    this.collections.get(c)!.set(id, JSON.parse(JSON.stringify(data)));
  }
  async fetchData<T>(c: string, id: string): Promise<T | null> {
    return (this.collections.get(c)?.get(id) as T) ?? null;
  }
  async queryData<T>(c: string, filters: QueryFilter[]): Promise<T[]> {
    const col = this.collections.get(c);
    if (!col) return [];
    return [...col.values()].filter((doc) =>
      filters.every((f) => {
        const v = (doc as any)[f.field];
        return f.operator === '==' ? v === f.value : false;
      })
    );
  }
  async updateData<T>(c: string, id: string, updates: Partial<T>): Promise<void> {
    const col = this.collections.get(c);
    if (!col) return;
    const existing = col.get(id) ?? {};
    col.set(id, { ...existing, ...updates });
  }
  async deleteData(c: string, id: string): Promise<void> {
    this.collections.get(c)?.delete(id);
  }
  async exists(c: string, id: string): Promise<boolean> {
    return !!this.collections.get(c)?.has(id);
  }
  async listIds(c: string): Promise<string[]> {
    return [...(this.collections.get(c)?.keys() ?? [])];
  }
  async getPhoto(): Promise<any | null> {
    return null;
  }
}

class MemStorage implements StorageAdapter {
  files: Map<string, Buffer> = new Map();
  async storeFile(path: string, data: Buffer): Promise<void> {
    this.files.set(path, Buffer.from(data));
  }
  async readFile(path: string): Promise<Buffer> {
    const f = this.files.get(path);
    if (!f) throw new Error('not found');
    return f;
  }
  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }
  async listFiles(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix));
  }
  async getSignedUrl(): Promise<string> {
    return 'sig://x';
  }
  async getDownloadUrl(): Promise<string> {
    return 'http://x';
  }
  async getFileSize(path: string): Promise<number> {
    return this.files.get(path)?.length ?? 0;
  }
}

interface CapturingSink {
  events: NormalizedMeteringEvent[];
  deliver(events: NormalizedMeteringEvent[]): Promise<void>;
}

function makeCapturingBus(): { bus: MeteringBus; sink: CapturingSink } {
  const sink: CapturingSink = {
    events: [],
    async deliver(events) {
      sink.events.push(...events);
    },
  };
  const bus = new MeteringBus({ sink, flushIntervalMs: 5, maxBatchSize: 1 });
  return { bus, sink };
}

async function flushBus(bus: MeteringBus): Promise<void> {
  await (bus as unknown as { flush: () => Promise<void> }).flush?.();
  await new Promise((r) => setTimeout(r, 20));
  await (bus as unknown as { flush: () => Promise<void> }).flush?.();
}

async function waitForCompletion(
  svc: TenantOffboardingService,
  tenantId: string,
  exportId: string
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const rec = await svc.getExport(tenantId, exportId);
    if (rec && (rec.status === 'ready' || rec.status === 'failed')) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('export did not complete');
}

describe('TenantOffboardingService', () => {
  let data: MemData;
  let storage: MemStorage;
  let svc: TenantOffboardingService;
  let captured: CapturingSink;
  let bus: MeteringBus;

  beforeEach(async () => {
    data = new MemData();
    storage = new MemStorage();
    svc = new TenantOffboardingService({ data, storage });
    const made = makeCapturingBus();
    bus = made.bus;
    captured = made.sink;
    setMeteringBus(bus);

    // Seed a 3-photo tenant.
    for (let i = 0; i < 3; i++) {
      await data.storeData('photos', `p${i}`, {
        id: `p${i}`,
        tenantId: 't1',
        bytes: 100,
      });
      await storage.storeFile(
        `tenants/t1/originals/p${i}.jpg`,
        Buffer.from(`fake-${i}`)
      );
    }
    await data.storeData('albums', 'a1', { id: 'a1', tenantId: 't1' });
    await data.storeData('libraries', 'l1', { id: 'l1', tenantId: 't1' });
    // Foreign tenant data that MUST NOT be touched.
    await data.storeData('photos', 'p99', { id: 'p99', tenantId: 't2' });
    await storage.storeFile('tenants/t2/originals/x.jpg', Buffer.from('other'));
  });

  afterEach(() => {
    setMeteringBus(null);
  });

  it('export request emits requested+completed and produces a manifest', async () => {
    const rec = await svc.requestExport('t1');
    expect(rec.status).toBe('pending');
    await waitForCompletion(svc, 't1', rec.id);
    const final = await svc.getExport('t1', rec.id);
    expect(final?.status).toBe('ready');
    expect(final?.bytes).toBeGreaterThan(0);
    expect(final?.downloadUrl).toBeTruthy();
    expect(final?.manifestSha256).toMatch(/^[a-f0-9]{64}$/);

    const archive = await storage.readFile(final!.storagePath);
    const text = archive.toString('utf8');
    expect(text).toContain('"tenantId":"t1"');
    expect(text).toContain('p0');
    expect(text).toContain('p1');
    expect(text).toContain('p2');
    expect(text).not.toContain('p99');

    await flushBus(bus);
    const types = captured.events.map((e) => e.type);
    expect(types).toContain('tenant.export.requested');
    expect(types).toContain('tenant.export.completed');
    const completed = captured.events.find(
      (e) => e.type === 'tenant.export.completed'
    );
    expect(completed?.tenantId).toBe('t1');
    expect(completed?.resourceId).toBe(rec.id);
    expect(completed?.bytes).toBe(final!.bytes);
  });

  it('getExport returns null for a foreign tenantId', async () => {
    const rec = await svc.requestExport('t1');
    await waitForCompletion(svc, 't1', rec.id);
    expect(await svc.getExport('t2', rec.id)).toBeNull();
  });

  it('delete sweep removes all tenant data and emits tenant.deleted once', async () => {
    const progress = await svc.deleteTenant('t1');
    expect(progress.completedAt).toBeTruthy();
    expect(progress.eventEmitted).toBe(true);
    expect(progress.itemsDeleted).toBeGreaterThan(0);

    expect(
      (await data.queryData('photos', [
        { field: 'tenantId', operator: '==', value: 't1' },
      ])).length
    ).toBe(0);
    expect(await storage.listFiles('tenants/t1/')).toEqual([]);
    expect(
      (await data.queryData('photos', [
        { field: 'tenantId', operator: '==', value: 't2' },
      ])).length
    ).toBe(1);
    expect(await storage.listFiles('tenants/t2/')).toEqual([
      'tenants/t2/originals/x.jpg',
    ]);

    await flushBus(bus);
    const deletedEvents = captured.events.filter(
      (e) => e.type === 'tenant.deleted'
    );
    expect(deletedEvents).toHaveLength(1);
    expect(deletedEvents[0]?.tenantId).toBe('t1');
    expect(((deletedEvents[0]?.meta ?? {}) as { itemsDeleted: number }).itemsDeleted).toBeGreaterThan(0);

    // Resuming a completed delete must not re-emit.
    await svc.deleteTenant('t1');
    await flushBus(bus);
    const afterResume = captured.events.filter(
      (e) => e.type === 'tenant.deleted'
    );
    expect(afterResume).toHaveLength(1);
  });

  it('partitioned collections list contains the documented surfaces', () => {
    expect(TENANT_PARTITIONED_COLLECTIONS).toContain('photos');
    expect(TENANT_PARTITIONED_COLLECTIONS).toContain('albums');
    expect(TENANT_PARTITIONED_COLLECTIONS).toContain('libraries');
    expect(TENANT_PARTITIONED_COLLECTIONS).toContain('tenantApiKeys');
  });
});
