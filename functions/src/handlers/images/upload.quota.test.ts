/**
 * Tests for the in-process per-tenant storage quota enforcement on upload.
 * See issue #139.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { handleUpload } from './upload.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import {
  InMemoryDailyDocStore,
} from '../../services/metering/UsageRollupConsumer.js';
import { TENANTS_COLLECTION, type TenantRecord } from '../../models/TenantRecord.js';

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

interface TenantSeed {
  quotaBytes: number | null;
}

function createDataAdapter(tenant?: TenantSeed): DataAdapter {
  const docs = new Map<string, unknown>();
  if (tenant !== undefined) {
    const record: TenantRecord = {
      id: 'default',
      quotaBytes: tenant.quotaBytes,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    docs.set(`${TENANTS_COLLECTION}::default`, record);
  }
  return {
    storeData: vi.fn(async (collection: string, id: string, data: unknown) => {
      docs.set(`${collection}::${id}`, data);
    }),
    fetchData: vi.fn(async <T>(collection: string, id: string) => {
      return (docs.get(`${collection}::${id}`) as T) ?? null;
    }),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(),
    deleteData: vi.fn(),
    exists: vi.fn(async () => false),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => null),
  };
}

function seedUsage(
  store: InMemoryDailyDocStore,
  tenantId: string,
  totalBytes: number
): Promise<void> {
  return store.setStorageBytesTotal(tenantId, isoToday(), totalBytes).then(() => undefined);
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildRequest(opts: {
  storage: StorageAdapter;
  data: DataAdapter;
  usageStore: InMemoryDailyDocStore;
  fileSize: number;
  tenantId?: string;
}): any {
  return {
    params: { libraryId: 'lib-1' },
    user: { uid: 'user-1' },
    tenantId: opts.tenantId,
    file: {
      originalname: 'photo.jpg',
      mimetype: 'image/jpeg',
      size: opts.fileSize,
      buffer: Buffer.alloc(opts.fileSize),
    },
    header: () => undefined,
    app: {
      locals: {
        storageAdapter: opts.storage,
        dataAdapter: opts.data,
        usageDailyStore: opts.usageStore,
      },
    },
  };
}

function buildResponse(): { res: any; status: any; json: any } {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  return { res: { status, json }, status, json };
}

describe('handleUpload — per-tenant storage quota (#139)', () => {
  beforeEach(() => {
    delete process.env.DEFAULT_TENANT_QUOTA_BYTES;
  });

  it('allows uploads strictly under the tenant quota', async () => {
    const usageStore = new InMemoryDailyDocStore();
    // Tenant id resolves to `lib:lib-1` (libraryId fallback).
    await seedUsage(usageStore, 'lib:lib-1', 100);
    const data = createDataAdapter();
    // Persist a tenant record under the resolved id (libraryId fallback).
    await data.storeData(TENANTS_COLLECTION, 'lib:lib-1', {
      id: 'lib:lib-1',
      quotaBytes: 1000,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const req = buildRequest({
      storage: createStorageAdapter(),
      data,
      usageStore,
      fileSize: 200, // 100 + 200 = 300 < 1000
    });
    const { res, status } = buildResponse();
    await expect(handleUpload(req, res)).resolves.toBeUndefined();
    expect(status).toHaveBeenCalledWith(202);
  });

  it('allows uploads that exactly hit the quota', async () => {
    const usageStore = new InMemoryDailyDocStore();
    await seedUsage(usageStore, 'lib:lib-1', 800);
    const data = createDataAdapter();
    await data.storeData(TENANTS_COLLECTION, 'lib:lib-1', {
      id: 'lib:lib-1',
      quotaBytes: 1000,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const req = buildRequest({
      storage: createStorageAdapter(),
      data,
      usageStore,
      fileSize: 200, // 800 + 200 == 1000
    });
    const { res, status } = buildResponse();
    await expect(handleUpload(req, res)).resolves.toBeUndefined();
    expect(status).toHaveBeenCalledWith(202);
  });

  it('rejects uploads that would exceed the quota with 413 quota_exceeded', async () => {
    const usageStore = new InMemoryDailyDocStore();
    await seedUsage(usageStore, 'lib:lib-1', 900);
    const data = createDataAdapter();
    await data.storeData(TENANTS_COLLECTION, 'lib:lib-1', {
      id: 'lib:lib-1',
      quotaBytes: 1000,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const req = buildRequest({
      storage: createStorageAdapter(),
      data,
      usageStore,
      fileSize: 200, // 900 + 200 > 1000
    });
    const { res } = buildResponse();
    await expect(handleUpload(req, res)).rejects.toMatchObject({
      statusCode: 413,
      code: 'quota_exceeded',
    } satisfies Partial<AppError>);
  });

  it('always allows uploads when quotaBytes is null (unlimited)', async () => {
    const usageStore = new InMemoryDailyDocStore();
    await seedUsage(usageStore, 'lib:lib-1', 1_000_000_000_000); // 1 TB used
    const data = createDataAdapter();
    await data.storeData(TENANTS_COLLECTION, 'lib:lib-1', {
      id: 'lib:lib-1',
      quotaBytes: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const req = buildRequest({
      storage: createStorageAdapter(),
      data,
      usageStore,
      fileSize: 5_000_000,
    });
    const { res, status } = buildResponse();
    await expect(handleUpload(req, res)).resolves.toBeUndefined();
    expect(status).toHaveBeenCalledWith(202);
  });

  it('quota_exceeded error carries usageBytes/quotaBytes/attemptedBytes details', async () => {
    const usageStore = new InMemoryDailyDocStore();
    await seedUsage(usageStore, 'lib:lib-1', 900);
    const data = createDataAdapter();
    await data.storeData(TENANTS_COLLECTION, 'lib:lib-1', {
      id: 'lib:lib-1',
      quotaBytes: 1000,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const req = buildRequest({
      storage: createStorageAdapter(),
      data,
      usageStore,
      fileSize: 200,
    });
    const { res } = buildResponse();
    try {
      await handleUpload(req, res);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.statusCode).toBe(413);
      expect(appErr.code).toBe('quota_exceeded');
      expect(appErr.details).toMatchObject({
        usageBytes: 900,
        quotaBytes: 1000,
        attemptedBytes: 200,
      });
    }
  });
});
