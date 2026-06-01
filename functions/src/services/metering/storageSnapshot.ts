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
import { buildStorageUsageReport } from '../../handlers/storage/usageReport.js';
import {
  isoDateUtc,
  type DailyDocStore,
  type UsageDailyDoc,
} from './UsageRollupConsumer.js';

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

export interface SnapshotOptions {
  storageAdapter: StorageAdapter;
  store: DailyDocStore;
  resolveTenantLibraries: TenantLibrariesResolver;
  emit?: RollupCompletedEmitter;
  /** Override the snapshot date (defaults to today UTC). */
  date?: string;
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
        activeUsers: 0,
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
