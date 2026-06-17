/**
 * purgeTrash — scheduled job that hard-deletes photos whose `trashedAt`
 * timestamp is older than `TRASH_RETENTION_DAYS` (default 30).
 *
 * Wired via the scheduler in production; runnable on demand in tests by
 * calling {@link runPurgeTrashJob} with a fake clock.
 *
 * Behavior (issue #152):
 *   - Iterates per-tenant so one noisy tenant cannot starve others.
 *   - Reuses the existing storage-cleanup path on the storage adapter.
 *   - Emits `photo.purged` exactly once per photo (host webhook).
 *   - Decrements the daily `storageBytesDelta` rollup via the usage bus.
 */

import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../adapters/storage/StorageAdapter.js';
import { PhotosService } from '../domain/photos/PhotosService.js';
import type { UsageMeteringBus } from '../services/metering/UsageMeteringBus.js';
import { logger } from '../utils/logger.js';

export const DEFAULT_TRASH_RETENTION_DAYS = 30;

export function resolveTrashRetentionDays(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.TRASH_RETENTION_DAYS;
  if (!raw) return DEFAULT_TRASH_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn(
      { raw },
      'TRASH_RETENTION_DAYS is not a non-negative number; using default'
    );
    return DEFAULT_TRASH_RETENTION_DAYS;
  }
  return n;
}

export interface PurgeTrashJobOptions {
  dataAdapter: DataAdapter;
  storageAdapter?: StorageAdapter;
  usageBus?: UsageMeteringBus;
  retentionDays?: number;
  /** Cap per-tenant work per run (default 1000). */
  perTenantLimit?: number;
  /** Test hook. */
  now?: () => Date;
}

export interface PurgeTrashJobResult {
  retentionDays: number;
  tenants: { tenantId: string; purgedPhotoIds: string[] }[];
  totalPurged: number;
}

export async function runPurgeTrashJob(
  opts: PurgeTrashJobOptions
): Promise<PurgeTrashJobResult> {
  const retentionDays =
    opts.retentionDays ?? resolveTrashRetentionDays();

  const service = new PhotosService({
    dataAdapter: opts.dataAdapter,
    storageAdapter: opts.storageAdapter,
    usageBus: opts.usageBus,
    now: opts.now,
  });

  const results = await service.purgeExpired({
    retentionDays,
    perTenantLimit: opts.perTenantLimit,
  });

  const totalPurged = results.reduce((acc, r) => acc + r.photoIds.length, 0);
  logger.info(
    { retentionDays, totalPurged, tenants: results.length },
    'purgeTrash job complete'
  );

  return {
    retentionDays,
    tenants: results.map((r) => ({
      tenantId: r.tenantId,
      purgedPhotoIds: r.photoIds,
    })),
    totalPurged,
  };
}
