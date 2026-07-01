/**
 * Per-tenant storage threshold evaluator (issue #196).
 *
 * Given a tenant's current quota and usage, emits webhook events when
 * usage **crosses** or **clears** a configured threshold. Hosts that
 * resell AuraPix subscribe to these events to drive billing / upsell /
 * hard-cap flows without polling `GET /v1/tenants/:id/usage`.
 *
 * Design notes:
 *   - Each threshold fires `tenant.storage.threshold_crossed` at most
 *     once per crossing direction. After a `_crossed` event the
 *     threshold is considered "armed for clear"; `_cleared` only fires
 *     once usage has dropped by at least
 *     {@link STORAGE_THRESHOLD_HYSTERESIS} below the threshold. This
 *     keeps webhook traffic quiet when usage hovers right around a
 *     threshold (#196 acceptance criteria).
 *   - State is persisted on the tenant doc (`storageThresholdState`),
 *     so a restart never re-fires events for thresholds that were
 *     already crossed.
 *   - Evaluation is piggy-backed on the upload quota check
 *     (`handlers/images/upload.ts`) and on the trash purge job
 *     (`jobs/purgeTrash.ts`). No new scheduler.
 *   - When `quotaBytes` is `null` (unlimited) or `<= 0`, the evaluator
 *     short-circuits and does nothing \u2014 thresholds are a percentage
 *     of the cap and only make sense when one is defined.
 *
 * The evaluator is **best-effort**: any error reading or writing the
 * tenant doc is logged at warn level and swallowed. We never want a
 * threshold-tracking failure to break an upload.
 */

import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import { logger } from '../../utils/logger.js';
import { emitMeteringEvent } from '../../services/metering/index.js';
import {
  DEFAULT_STORAGE_THRESHOLDS,
  STORAGE_THRESHOLD_HYSTERESIS,
  TENANTS_COLLECTION,
  thresholdStateKey,
  type StorageThresholdState,
  type TenantRecord,
} from '../../models/TenantRecord.js';
import type { TenantId } from '../../domain/tenant/Tenant.js';

export interface EvaluateStorageThresholdsInput {
  dataAdapter: DataAdapter;
  tenantId: TenantId;
  /** Current storage usage in bytes (post-write for uploads, post-purge for trash). */
  usedBytes: number;
  /**
   * Test hook for deterministic `crossedAt` / `clearedAt` values. Defaults
   * to `new Date()`.
   */
  now?: () => Date;
  /**
   * Optional pre-fetched tenant record. Callers that already loaded the
   * record (e.g. the upload handler's quota check) can pass it in to
   * avoid a second read. The evaluator will still write back to the
   * data adapter when state changes.
   */
  tenantRecord?: TenantRecord;
}

export interface ThresholdTransition {
  threshold: number;
  direction: 'crossed' | 'cleared';
}

export interface EvaluateStorageThresholdsResult {
  /**
   * One entry per threshold that changed state during this evaluation.
   * In practice usually 0 or 1; multi-step transitions happen when a
   * single upload spans several thresholds at once.
   */
  transitions: ThresholdTransition[];
}

/**
 * Resolve the effective threshold list for a tenant. Sorted ascending,
 * deduped via the canonical {@link thresholdStateKey} representation.
 */
export function resolveThresholds(record: TenantRecord | null | undefined): number[] {
  const raw =
    record?.storageThresholds && record.storageThresholds.length > 0
      ? record.storageThresholds
      : DEFAULT_STORAGE_THRESHOLDS;
  const seen = new Set<string>();
  const out: number[] = [];
  for (const t of raw) {
    if (!Number.isFinite(t) || t <= 0) continue;
    const fixed = Number(t.toFixed(3));
    const key = fixed.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fixed);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Pure decision function: given the previous per-threshold state, a
 * fresh usage reading, and the quota, return the next state plus the
 * list of transitions (events to fire).
 *
 * Hysteresis rule: a threshold flips from `crossed=true` back to
 * `crossed=false` (and fires `_cleared`) only when
 *   `usedFraction <= threshold - STORAGE_THRESHOLD_HYSTERESIS`.
 * This guarantees no oscillation when usage hovers right around the
 * threshold.
 *
 * Exposed for unit tests.
 */
export function computeTransitions(args: {
  thresholds: readonly number[];
  usedBytes: number;
  quotaBytes: number;
  previousState: Record<string, StorageThresholdState>;
  now: Date;
}): {
  nextState: Record<string, StorageThresholdState>;
  transitions: ThresholdTransition[];
} {
  const { thresholds, usedBytes, quotaBytes, previousState, now } = args;
  const transitions: ThresholdTransition[] = [];
  const nextState: Record<string, StorageThresholdState> = { ...previousState };

  // Guard: quotaBytes must be > 0 for fractions to be meaningful.
  if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
    return { nextState, transitions };
  }

  const usedFraction = Math.max(0, usedBytes) / quotaBytes;
  const isoNow = now.toISOString();

  for (const threshold of thresholds) {
    const key = thresholdStateKey(threshold);
    const prior = previousState[key] ?? { crossed: false };

    if (!prior.crossed && usedFraction >= threshold) {
      // First time crossing this threshold (or first time since clear).
      nextState[key] = {
        ...prior,
        crossed: true,
        lastCrossedAt: isoNow,
      };
      transitions.push({ threshold, direction: 'crossed' });
      continue;
    }

    if (prior.crossed && usedFraction <= threshold - STORAGE_THRESHOLD_HYSTERESIS) {
      // Cleared, with hysteresis band satisfied.
      nextState[key] = {
        ...prior,
        crossed: false,
        lastClearedAt: isoNow,
      };
      transitions.push({ threshold, direction: 'cleared' });
      continue;
    }

    // No change. Carry prior state forward unchanged so we don't
    // accidentally erase `lastCrossedAt` / `lastClearedAt` observability
    // fields by writing `undefined` over them.
    nextState[key] = prior;
  }

  return { nextState, transitions };
}

/**
 * Evaluate the tenant's current usage against its threshold config and
 * emit any `tenant.storage.threshold_crossed` / `_cleared` events that
 * are due. Persists updated state back to the tenant doc.
 *
 * Never throws \u2014 errors are logged and swallowed so callers can wire
 * this safely on the hot path (upload quota check, purge job).
 */
export async function evaluateStorageThresholds(
  input: EvaluateStorageThresholdsInput
): Promise<EvaluateStorageThresholdsResult> {
  const { dataAdapter, tenantId, usedBytes } = input;
  const now = (input.now ?? (() => new Date()))();
  try {
    // Re-read the tenant record (or accept a pre-fetched one) so we
    // always update the freshest version. We deliberately don't lock
    // here; the worst case under racy uploads is a duplicate event,
    // which is bounded by hysteresis on the next evaluation.
    const existing =
      input.tenantRecord ??
      (await dataAdapter.fetchData<TenantRecord>(TENANTS_COLLECTION, tenantId));

    const quotaBytes = existing?.quotaBytes ?? null;
    if (quotaBytes === null || quotaBytes <= 0) {
      // Unlimited quota or no upload allowed at all \u2014 threshold events
      // do not apply. (`quotaBytes === 0` means uploads are blocked
      // entirely; firing a "100% full" event there is misleading.)
      return { transitions: [] };
    }

    const thresholds = resolveThresholds(existing ?? null);
    if (thresholds.length === 0) {
      return { transitions: [] };
    }

    const previousState = existing?.storageThresholdState ?? {};
    const { nextState, transitions } = computeTransitions({
      thresholds,
      usedBytes,
      quotaBytes,
      previousState,
      now,
    });

    if (transitions.length === 0) {
      return { transitions: [] };
    }

    // Persist state first, then emit. If the write fails we won't
    // accidentally re-fire on the next call (state stays as previous,
    // so this evaluation's effects are simply lost \u2014 the next upload
    // will retry).
    const nowIso = now.toISOString();
    const nextRecord: TenantRecord = {
      id: tenantId,
      quotaBytes: existing?.quotaBytes ?? quotaBytes,
      storageThresholds:
        existing?.storageThresholds === undefined
          ? null
          : existing.storageThresholds,
      storageThresholdState: nextState,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    await dataAdapter.storeData(TENANTS_COLLECTION, tenantId, nextRecord);

    // Emit one event per transition. Sorted ascending by threshold so
    // hosts that process the batch in order see the natural progression
    // (e.g. 0.5 crossed before 0.8).
    for (const t of transitions) {
      if (t.direction === 'crossed') {
        emitMeteringEvent({
          tenantId,
          type: 'tenant.storage.threshold_crossed',
          count: 1,
          resourceId: thresholdStateKey(t.threshold),
          occurredAt: nowIso,
          meta: {
            tenantId,
            threshold: t.threshold,
            usedBytes: Math.max(0, usedBytes),
            quotaBytes,
            crossedAt: nowIso,
          },
        });
      } else {
        emitMeteringEvent({
          tenantId,
          type: 'tenant.storage.threshold_cleared',
          count: 1,
          resourceId: thresholdStateKey(t.threshold),
          occurredAt: nowIso,
          meta: {
            tenantId,
            threshold: t.threshold,
            usedBytes: Math.max(0, usedBytes),
            quotaBytes,
            clearedAt: nowIso,
          },
        });
      }
    }

    return { transitions };
  } catch (err) {
    logger.warn(
      { err, tenantId, usedBytes },
      'evaluateStorageThresholds: failed; swallowing to keep caller hot path healthy'
    );
    return { transitions: [] };
  }
}
