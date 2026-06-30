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
 *
 * Threshold clearing (issue #196):
 *   - When a `usageStore` is provided, evaluates per-tenant storage
 *     thresholds after each tenant's purge completes so
 *     `tenant.storage.threshold_cleared` events fire when bytes
 *     reclaimed bring usage back below a previously-crossed threshold
 *     (after hysteresis). When no `usageStore` is wired, this step is
 *     skipped silently and the next upload's piggy-backed evaluation
 *     will catch up.
 */

import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../adapters/storage/StorageAdapter.js';
import { PhotosService } from '../domain/photos/PhotosService.js';
import type { UsageMeteringBus } from '../services/metering/UsageMeteringBus.js';
import { resolveTenantTrashRetentionDays } from '../services/host/tenantFeaturesConfigService.js';
import { evaluateStorageThresholds } from '../services/tenant/storageThresholdEvaluator.js';
import { readCurrentUsageBytes } from '../services/metering/currentUsage.js';
import type { DailyDocStore } from '../services/metering/UsageRollupConsumer.js';
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
   * Optional usage store used by the issue #196 threshold evaluator to
   * compute fresh post-purge `usedBytes` per tenant. Without it the
   * `tenant.storage.threshold_cleared` event cannot fire from this job;
   * the next upload for that tenant will still trip the evaluator and
   * emit the cleared event then.
   */
  usageStore?: DailyDocStore;
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

  // Issue #196: after each tenant's purge, re-evaluate storage
  // thresholds so `tenant.storage.threshold_cleared` events fire when
  // the reclaimed bytes bring usage back below a previously-crossed
  // threshold (after hysteresis). Skipped silently when no usage store
  // is wired — the next upload's piggy-backed evaluation will catch up.
  if (opts.usageStore) {
    for (const r of results) {
      if (r.photoIds.length === 0) continue;
      try {
        const usedBytes = await readCurrentUsageBytes(
          opts.usageStore,
          String(r.tenantId)
        );
        await evaluateStorageThresholds({
          dataAdapter: opts.dataAdapter,
          tenantId: r.tenantId,
          usedBytes,
        });
      } catch (err) {
        logger.warn(
          { err, tenantId: r.tenantId },
          'purgeTrash: threshold re-evaluation failed; continuing'
        );
      }
    }
  }

  return {
    retentionDays,
    tenants: results.map((r) => ({
      tenantId: r.tenantId,
      purgedPhotoIds: r.photoIds,
    })),
    totalPurged,
  };
}
