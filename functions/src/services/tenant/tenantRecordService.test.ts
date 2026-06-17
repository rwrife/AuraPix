/**
 * Unit tests for the tenant record CRUD service (#139).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  getTenantRecord,
  patchTenantRecord,
  validateQuotaBytesInput,
} from './tenantRecordService.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import { TENANTS_COLLECTION, type TenantRecord } from '../../models/TenantRecord.js';

function createDataAdapter(seed?: Record<string, unknown>): DataAdapter {
  const docs = new Map<string, unknown>(Object.entries(seed ?? {}));
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

describe('tenantRecordService', () => {
  beforeEach(() => {
    delete process.env.DEFAULT_TENANT_QUOTA_BYTES;
  });

  it('returns a synthesized record with null quota when no doc exists and no env default', async () => {
    const data = createDataAdapter();
    const rec = await getTenantRecord(data, 'tenant-a');
    expect(rec.id).toBe('tenant-a');
    expect(rec.quotaBytes).toBeNull();
  });

  it('returns env-driven default quota when no doc exists', async () => {
    process.env.DEFAULT_TENANT_QUOTA_BYTES = '53687091200'; // 50 GB
    const data = createDataAdapter();
    const rec = await getTenantRecord(data, 'tenant-a');
    expect(rec.quotaBytes).toBe(53687091200);
  });

  it('honors persisted quotaBytes (including 0 and null)', async () => {
    const existing: TenantRecord = {
      id: 'tenant-z',
      quotaBytes: 0,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const data = createDataAdapter({
      [`${TENANTS_COLLECTION}::tenant-z`]: existing,
    });
    expect((await getTenantRecord(data, 'tenant-z')).quotaBytes).toBe(0);

    const existingNull: TenantRecord = {
      id: 'tenant-n',
      quotaBytes: null,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const data2 = createDataAdapter({
      [`${TENANTS_COLLECTION}::tenant-n`]: existingNull,
    });
    expect((await getTenantRecord(data2, 'tenant-n')).quotaBytes).toBeNull();
  });

  it('patch persists quotaBytes and updates updatedAt', async () => {
    const data = createDataAdapter();
    const updated = await patchTenantRecord(data, 'tenant-x', {
      quotaBytes: 1024,
    });
    expect(updated.quotaBytes).toBe(1024);
    expect(data.storeData).toHaveBeenCalledWith(
      TENANTS_COLLECTION,
      'tenant-x',
      expect.objectContaining({ quotaBytes: 1024 })
    );
  });

  it('patch can clear quotaBytes to null', async () => {
    const data = createDataAdapter({
      [`${TENANTS_COLLECTION}::tenant-x`]: {
        id: 'tenant-x',
        quotaBytes: 999,
        createdAt: 'x',
        updatedAt: 'x',
      },
    });
    const updated = await patchTenantRecord(data, 'tenant-x', {
      quotaBytes: null,
    });
    expect(updated.quotaBytes).toBeNull();
  });

  it('validateQuotaBytesInput accepts null and non-negative finite numbers', () => {
    expect(validateQuotaBytesInput(null)).toBeNull();
    expect(validateQuotaBytesInput(0)).toBe(0);
    expect(validateQuotaBytesInput(1024)).toBe(1024);
    expect(validateQuotaBytesInput(1024.7)).toBe(1024);
  });

  it('validateQuotaBytesInput rejects garbage', () => {
    expect(() => validateQuotaBytesInput(-1)).toThrow();
    expect(() => validateQuotaBytesInput('big')).toThrow();
    expect(() => validateQuotaBytesInput(NaN)).toThrow();
    expect(() => validateQuotaBytesInput(Infinity)).toThrow();
    expect(() => validateQuotaBytesInput(undefined)).toThrow();
  });
});
