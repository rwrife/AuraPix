/**
 * Read the best-available "current storage usage" for a tenant, sourced
 * from the per-tenant daily rollup docs maintained by
 * {@link UsageRollupConsumer} and the scheduled snapshot job.
 *
 * The snapshot job writes `storageBytesTotal` once per day. Between
 * snapshots, `storageBytesDelta` on today's doc reflects the bytes added
 * (or removed) since the last snapshot. So:
 *
 *   currentUsageBytes ≈ (today.storageBytesTotal ?? mostRecentTotal ?? 0)
 *                     + today.storageBytesDelta when today.storageBytesTotal is null
 *
 * Defense-in-depth quota enforcement uses this to short-circuit oversized
 * uploads even when the host's metering webhook is down — see
 * `handlers/images/upload.ts`.
 */
import {
  isoDateUtc,
  type DailyDocStore,
  type UsageDailyDoc,
} from './UsageRollupConsumer.js';

export async function readCurrentUsageBytes(
  store: DailyDocStore,
  tenantId: string,
  now: Date = new Date()
): Promise<number> {
  const today = isoDateUtc(now);
  // Use a no-op transact to read today's doc atomically.
  const doc: UsageDailyDoc | null = await store.transact(
    tenantId,
    today,
    (current) =>
      current ?? {
        tenantId,
        date: today,
        storageBytesDelta: 0,
        imagesUploaded: 0,
        imagesProcessed: 0,
        signedUrlsIssued: 0,
        editsApplied: 0,
        apiCalls: 0,
        tagsApplied: 0,
        exportBytes: 0,
        shareEgressBytes: 0,
        activeUsers: 0,
        rateLimited: 0,
        storageBytesTotal: null,
        appliedEventIds: [],
        updatedAt: new Date(0).toISOString(),
      }
  );

  if (doc.storageBytesTotal !== null && doc.storageBytesTotal !== undefined) {
    // Snapshot has run today; trust it (and add same-day delta since it ran).
    return Math.max(0, doc.storageBytesTotal + (doc.storageBytesDelta ?? 0));
  }
  // No snapshot today yet — fall back to today's delta as a lower bound.
  return Math.max(0, doc.storageBytesDelta ?? 0);
}
