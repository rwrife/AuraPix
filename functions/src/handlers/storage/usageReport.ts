import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';

export interface StorageUsageTotals {
  files: number;
  bytes: number;
}

export interface StorageUsagePhotoBreakdown {
  photoId: string;
  originalsBytes: number;
  derivativesBytes: number;
  totalBytes: number;
}

export interface StorageUsageReport {
  libraryId: string;
  generatedAt: string;
  totals: {
    originals: StorageUsageTotals;
    derivatives: StorageUsageTotals;
    combined: StorageUsageTotals;
  };
  photos: StorageUsagePhotoBreakdown[];
}

function extractPhotoId(path: string): string | null {
  // Expected: {bucket-segment}/<libraryId>/<photoId>/...
  const segments = path.split('/');
  if (segments.length < 4) return null;
  return segments[2] || null;
}

async function summarizePaths(
  storageAdapter: StorageAdapter,
  paths: string[]
): Promise<{ files: number; bytes: number; byPhotoId: Map<string, number> }> {
  let bytes = 0;
  const byPhotoId = new Map<string, number>();

  for (const filePath of paths) {
    const size = await storageAdapter.getFileSize(filePath);
    bytes += size;

    const photoId = extractPhotoId(filePath);
    if (!photoId) continue;
    byPhotoId.set(photoId, (byPhotoId.get(photoId) ?? 0) + size);
  }

  return {
    files: paths.length,
    bytes,
    byPhotoId,
  };
}

export async function buildStorageUsageReport(
  storageAdapter: StorageAdapter,
  libraryId: string
): Promise<StorageUsageReport> {
  const [originalPaths, derivativePaths] = await Promise.all([
    storageAdapter.listFiles(`originals/${libraryId}/`),
    storageAdapter.listFiles(`derivatives/${libraryId}/`),
  ]);

  const [originals, derivatives] = await Promise.all([
    summarizePaths(storageAdapter, originalPaths),
    summarizePaths(storageAdapter, derivativePaths),
  ]);

  const photoIds = new Set<string>([
    ...originals.byPhotoId.keys(),
    ...derivatives.byPhotoId.keys(),
  ]);

  const photos = Array.from(photoIds)
    .map((photoId) => {
      const originalsBytes = originals.byPhotoId.get(photoId) ?? 0;
      const derivativesBytes = derivatives.byPhotoId.get(photoId) ?? 0;
      return {
        photoId,
        originalsBytes,
        derivativesBytes,
        totalBytes: originalsBytes + derivativesBytes,
      };
    })
    .sort((a, b) => b.totalBytes - a.totalBytes);

  return {
    libraryId,
    generatedAt: new Date().toISOString(),
    totals: {
      originals: {
        files: originals.files,
        bytes: originals.bytes,
      },
      derivatives: {
        files: derivatives.files,
        bytes: derivatives.bytes,
      },
      combined: {
        files: originals.files + derivatives.files,
        bytes: originals.bytes + derivatives.bytes,
      },
    },
    photos,
  };
}
