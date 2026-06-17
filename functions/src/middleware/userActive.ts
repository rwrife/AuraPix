/**
 * userActive middleware — emits one `user.active` metering event per
 * `(tenantId, userId, utcDay)` triple for seat-based billing (issue #153).
 *
 * Placement: AFTER `authMiddleware` (so `req.user` is populated) and AFTER
 * `resolveTenant` (so `req.tenantId` is populated). The middleware skips
 * when the request was authenticated via a host API key (`req.tenant`
 * present, `req.user` absent) — service-to-service traffic must NOT
 * generate seat activity.
 *
 * Behaviour:
 *   - First hit of the UTC day for `(tenantId, userId)`: emits one
 *     `user.active` event onto the host webhook bus AND publishes an
 *     `activeUsers += 1` event onto the UsageMeteringBus for the daily
 *     rollup.
 *   - Subsequent hits the same day: no-op.
 *   - Never blocks the request; all emit errors are swallowed.
 */
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { emitMeteringEvent } from '../services/metering/index.js';
import type { UsageMeteringBus } from '../services/metering/UsageMeteringBus.js';
import {
  type UserActiveDailyStore,
  utcDayString,
} from '../services/metering/UserActiveDailyStore.js';

export interface UserActiveMiddlewareDeps {
  store: UserActiveDailyStore;
  /**
   * Optional UsageMeteringBus to receive `activeUsers` counter increments
   * (drives the daily rollup `activeUsers` column). When omitted, only the
   * webhook-fanout `user.active` event is emitted.
   */
  usageBus?: UsageMeteringBus;
  /** Override for tests. */
  now?: () => Date;
}

export function createUserActiveMiddleware(deps: UserActiveMiddlewareDeps) {
  const now = deps.now ?? (() => new Date());

  return async function userActive(
    req: Request,
    _res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      // Skip host-API-key (service-to-service) requests entirely.
      if (req.tenant && !req.user) {
        next();
        return;
      }
      const userId = req.user?.uid;
      const tenantId = req.tenantId;
      if (!userId || !tenantId) {
        next();
        return;
      }

      const today = now();
      const utcDay = utcDayString(today);

      const isFirst = await deps.store.markIfFirst(tenantId, userId, utcDay);
      if (!isFirst) {
        next();
        return;
      }

      const firstSeenAt = today.toISOString();

      // Webhook fanout event (issue #130/#137).
      emitMeteringEvent({
        type: 'user.active',
        tenantId,
        count: 1,
        resourceId: userId,
        occurredAt: firstSeenAt,
        meta: { firstSeenAt, route: req.path },
      });

      // Daily rollup column (#133 + #153).
      if (deps.usageBus) {
        // Fire-and-forget; publish() in the in-memory impl awaits handlers
        // but we don't want to delay the request on the rollup write.
        void deps.usageBus
          .publish({
            tenantId,
            counter: 'activeUsers',
            value: 1,
            occurredAt: firstSeenAt,
            eventId: `user.active:${tenantId}:${userId}:${utcDay}`,
            meta: { userId, route: req.path },
          })
          .catch((err) => {
            logger.warn({ err, tenantId, userId }, 'activeUsers publish failed');
          });
      }
    } catch (err) {
      logger.warn({ err, path: req.path }, 'userActive middleware error');
    }
    next();
  };
}
