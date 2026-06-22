/**
 * purgeTrash — scheduled job that hard-deletes photos whose `trashedAt`
 * timestamp is older than the effective retention window.
 *
 * Wired via the scheduler in production; runnable on demand in tests by
 * calling {@link runPurgeTrashJob} with a fake clock.
 *
 * Retention resolution (issue #183):
 *   - Per-tenant override on the features-config doc wins when present
 *     and within `[1, 365]`.
 *   - Otherwise the deployment-wide default from
 *     `TRASH_RETENTION_DAYS` (or `DEFAULT_TRASH_RETENTION_DAYS`) is used.
 *   - Invalid per-tenant values log WARN and fall back to the default.
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
import { resolveTenantTrashRetentionDays } from '../services/host/tenantFeaturesConfigService.js';
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
  /**
   * Deployment-wide default retention. Per-tenant overrides on the
   * features-config doc take precedence; pass this when you want to
   * pin the default instead of reading `TRASH_RETENTION_DAYS` from env.
   */
  retentionDays?: number;
  /** Cap per-tenant work per run (default 1000). */
  perTenantLimit?: number;
  /** Test hook. */
  now?: () => Date;
  /**
   * Disable per-tenant resolution (test/diagnostic hook). When `true`,
   * every tenant uses the deployment default. Defaults to `false`.
   */
  disablePerTenantOverride?: boolean;
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
    // Resolve per-tenant Trash retention from the features-config doc
    // (issue #183). The resolver is closure-captured so the data adapter
    // does not have to leak into PhotosService.
    resolveRetentionDays: opts.disablePerTenantOverride
      ? undefined
      : (tenantId) =>
          resolveTenantTrashRetentionDays(
            opts.dataAdapter,
            String(tenantId),
            retentionDays
          ),
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
