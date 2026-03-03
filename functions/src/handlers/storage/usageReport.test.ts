import { describe, expect, it } from 'vitest';
import { buildStorageUsageReport } from './usageReport.js';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';

describe('buildStorageUsageReport', () => {
  it('summarizes originals and derivatives with per-photo totals', async () => {
    const sizes: Record<string, number> = {
      'originals/lib-1/photo-a/original.jpg': 100,
      'originals/lib-1/photo-b/original.jpg': 200,
      'derivatives/lib-1/photo-a/thumb_small.webp': 25,
      'derivatives/lib-1/photo-a/thumb_medium.webp': 35,
      'derivatives/lib-1/photo-b/thumb_small.webp': 40,
    };

    const storageAdapter: StorageAdapter = {
      storeFile: async () => undefined,
      readFile: async () => Buffer.alloc(0),
      fileExists: async () => true,
      deleteFile: async () => undefined,
      listFiles: async (prefix: string) =>
        Object.keys(sizes).filter((path) => path.startsWith(prefix)),
      getFileSize: async (path: string) => sizes[path] ?? 0,
    };

    const report = await buildStorageUsageReport(storageAdapter, 'lib-1');

    expect(report.libraryId).toBe('lib-1');
    expect(report.totals.originals).toEqual({ files: 2, bytes: 300 });
    expect(report.totals.derivatives).toEqual({ files: 3, bytes: 100 });
    expect(report.totals.combined).toEqual({ files: 5, bytes: 400 });

    expect(report.photos).toEqual([
      {
        photoId: 'photo-b',
        originalsBytes: 200,
        derivativesBytes: 40,
        totalBytes: 240,
      },
      {
        photoId: 'photo-a',
        originalsBytes: 100,
        derivativesBytes: 60,
        totalBytes: 160,
      },
    ]);
  });
});
