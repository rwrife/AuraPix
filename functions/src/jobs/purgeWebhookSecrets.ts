/**
 * purgeWebhookSecrets — scheduled job that drops expired `previous`
 * webhook signing secrets across all tenants (issue #161).
 *
 * Behavior:
 *   - Iterates the `tenantWebhookSecrets` collection.
 *   - For any tenant whose `previousExpiresAt` is in the past, removes the
 *     `previous` material so the sink stops dual-signing with it.
 *   - Idempotent: safe to run repeatedly.
 *
 * Wired into the scheduler (Cloud Functions schedule) in a follow-up so
 * production rotations actually purge on time; in local mode this can be
 * invoked manually from a debug endpoint or test.
 */

import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { purgeExpiredPreviousSecrets } from '../services/host/tenantWebhookSecretService.js';
import { logger } from '../utils/logger.js';

export interface PurgeWebhookSecretsJobOptions {
  dataAdapter: DataAdapter;
  /** Test hook. */
  now?: () => Date;
}

export interface PurgeWebhookSecretsJobResult {
  /** Tenants whose `previous` material was dropped this run. */
  tenantIds: string[];
  totalPurged: number;
}

export async function runPurgeWebhookSecretsJob(
  opts: PurgeWebhookSecretsJobOptions
): Promise<PurgeWebhookSecretsJobResult> {
  const result = await purgeExpiredPreviousSecrets(opts.dataAdapter, {
    now: opts.now,
  });
  logger.info(
    { totalPurged: result.tenantIds.length },
    'purgeWebhookSecrets job complete'
  );
  return {
    tenantIds: result.tenantIds,
    totalPurged: result.tenantIds.length,
  };
}
