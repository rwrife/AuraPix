/**
 * Daily storage snapshot job. For each tenant, recomputes the absolute
 * storageBytesTotal using the existing storage-usage logic and writes it onto
 * today's `usageDaily/{YYYY-MM-DD}` doc. Bounds drift from delta-only rollups.
 *
 * Idempotent: re-running the job on the same day overwrites the snapshot
 * value, it does not double-count.
 *
 * Emits one `metering.rollup.completed` event per tenant per day via the
 * provided emitter (so hosts can push-trigger billing instead of polling).
 */
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import { buildStorageUsageReport } from '../../handlers/storage/usageReport.js';
import {
  isoDateUtc,
  type DailyDocStore,
  type UsageDailyDoc,
} from './UsageRollupConsumer.js';
import { emitMeteringEvent } from './index.js';
import { getTenantRecord } from '../tenant/tenantRecordService.js';

export interface RollupCompletedEvent {
  type: 'metering.rollup.completed';
  tenantId: string;
  date: string;
  storageBytesTotal: number;
  occurredAt: string;
}

export type RollupCompletedEmitter = (
  event: RollupCompletedEvent
) => Promise<void> | void;

/**
 * Resolves the set of libraryIds owned by a tenant. Until the tenantId model
 * lands (its own issue), callers can pass a tenant->libraries function that
 * returns the legacy single-library mapping.
 */
export type TenantLibrariesResolver = (tenantId: string) => Promise<string[]>;

/**
 * Configurable warning thresholds (fractions of quotaBytes). At most one
 * `quota.warning` event is emitted per threshold per tenant per day, since
 * the daily-doc transact is idempotent on the `quotaWarningsEmitted` set.
 */
const QUOTA_WARNING_THRESHOLDS: number[] = (() => {
  const raw = process.env.TENANT_QUOTA_WARNING_THRESHOLDS?.trim();
  if (!raw) return [0.8, 0.95];
  const parsed = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 1);
  return parsed.length > 0 ? parsed : [0.8, 0.95];
})();

export interface SnapshotOptions {
  storageAdapter: StorageAdapter;
  store: DailyDocStore;
  resolveTenantLibraries: TenantLibrariesResolver;
  emit?: RollupCompletedEmitter;
  /** Override the snapshot date (defaults to today UTC). */
  date?: string;
  /**
   * Optional data adapter used to look up tenant quota for warning-event
   * emission. Omit to disable quota warnings (snapshot still runs).
   */
  dataAdapter?: DataAdapter;
}

export async function snapshotTenantStorage(
  tenantId: string,
  opts: SnapshotOptions
): Promise<UsageDailyDoc> {
  const date = opts.date ?? isoDateUtc(undefined);
  const libraries = await opts.resolveTenantLibraries(tenantId);

  let totalBytes = 0;
  for (const libraryId of libraries) {
    const report = await buildStorageUsageReport(opts.storageAdapter, libraryId);
    totalBytes += report.totals.combined.bytes;
  }

  const updated = await opts.store.transact(tenantId, date, (current) => {
    const base =
      current ?? {
        tenantId,
        date,
        storageBytesDelta: 0,
        imagesUploaded: 0,
        imagesProcessed: 0,
        signedUrlsIssued: 0,
        editsApplied: 0,
        apiCalls: 0,
        storageBytesTotal: null,
        appliedEventIds: [] as string[],
        updatedAt: new Date(0).toISOString(),
      };
    return {
      ...base,
      storageBytesTotal: totalBytes,
      updatedAt: new Date().toISOString(),
    };
  });

  // Best-effort quota.warning emission. We re-transact the doc to record
  // which thresholds have already fired today (idempotent per threshold).
  if (opts.dataAdapter) {
    try {
      const tenantRecord = await getTenantRecord(opts.dataAdapter, tenantId);
      const quota = tenantRecord.quotaBytes;
      if (quota && quota > 0) {
        const ratio = totalBytes / quota;
        const crossed = QUOTA_WARNING_THRESHOLDS.filter((t) => ratio >= t);
        if (crossed.length > 0) {
          await opts.store.transact(tenantId, date, (current) => {
            const base = current ?? updated;
            const already = new Set<number>(
              ((base as UsageDailyDoc & { quotaWarningsEmitted?: number[] })
                .quotaWarningsEmitted ?? []) as number[]
            );
            for (const t of crossed) {
              if (!already.has(t)) {
                already.add(t);
                emitMeteringEvent({
                  tenantId,
                  type: 'quota.warning',
                  count: 1,
                  bytes: totalBytes,
                  meta: {
                    threshold: t,
                    quotaBytes: quota,
                    usageBytes: totalBytes,
                    date,
                  },
                });
              }
            }
            return {
              ...base,
              quotaWarningsEmitted: Array.from(already).sort(),
              updatedAt: new Date().toISOString(),
            } as UsageDailyDoc;
          });
        }
      }
    } catch {
      // Snapshot job must never fail on quota-warning emission.
    }
  }

  if (opts.emit) {
    await opts.emit({
      type: 'metering.rollup.completed',
      tenantId,
      date,
      storageBytesTotal: totalBytes,
      occurredAt: new Date().toISOString(),
    });
  }

  return updated;
}

export async function snapshotAllTenants(
  tenantIds: string[],
  opts: SnapshotOptions
): Promise<UsageDailyDoc[]> {
  const results: UsageDailyDoc[] = [];
  for (const tenantId of tenantIds) {
    results.push(await snapshotTenantStorage(tenantId, opts));
  }
  return results;
}
