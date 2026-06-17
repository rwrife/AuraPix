/**
 * Host webhook delivery observability (issue #144).
 *
 * Exposes two host-key-authenticated endpoints under
 * `/api/v1/tenants/:tenantId/webhooks`:
 *
 *   GET    /deliveries?status=failed&since=...&limit=...&cursor=...
 *   POST   /deliveries/:batchId:replay
 *
 * Auth: requires a host API key with the `webhooks.write` scope for the
 * target tenant (replay is a write). The list endpoint is read-only but
 * uses the same scope to keep the configuration surface narrow — anyone\n * able to see failed deliveries can also retry them.\n *\n * Records are short-lived (Firestore TTL = 30 days). Bodies are NOT\n * stored; replay reconstructs the payload from an in-process cache held\n * by the sink (best-effort within the in-flight window). Replays outside\n * that window return 410 GONE.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireUserOrTenantScopes } from '../middleware/hostApiKeyAuth.js';
import type { HostWebhookSink } from '../services/metering/HostWebhookSink.js';
import type {
  WebhookDeliveryStatus,
  WebhookDeliveryStore,
} from '../services/metering/WebhookDeliveryStore.js';

export interface WebhookDeliveriesRouterDeps {
  store: WebhookDeliveryStore;
  /** Sink used to replay batches. Optional: when absent, replay returns 503. */
  sink?: HostWebhookSink;
}

const ALLOWED_STATUSES = new Set<WebhookDeliveryStatus>([
  'pending',
  'ok',
  'failed',
]);

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> | null = null
): void {
  res.status(status).json({
    error: {
      code,
      message,
      requestId: randomUUID(),
      details,
    },
  });
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

export function createWebhookDeliveriesRouter(
  deps: WebhookDeliveriesRouterDeps
): Router {
  const router = Router({ mergeParams: true });

  const tenantFromParams = (req: Request): string | undefined =>
    req.params.tenantId ? String(req.params.tenantId) : undefined;

  const guard = requireUserOrTenantScopes({
    scopes: ['webhooks.write'],
    tenantIdFromReq: tenantFromParams,
  });

  // GET /:tenantId/webhooks/deliveries
  router.get(
    '/:tenantId/webhooks/deliveries',
    guard,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        if (!tenantId) {
          sendError(res, 400, 'VALIDATION_ERROR', 'tenantId is required');
          return;
        }

        const statusParam = req.query.status
          ? String(req.query.status)
          : undefined;
        if (statusParam && !ALLOWED_STATUSES.has(statusParam as WebhookDeliveryStatus)) {
          sendError(
            res,
            400,
            'VALIDATION_ERROR',
            'status must be one of pending|ok|failed',
            { status: statusParam }
          );
          return;
        }

        const since = req.query.since ? String(req.query.since) : undefined;
        if (since && Number.isNaN(new Date(since).getTime())) {
          sendError(
            res,
            400,
            'VALIDATION_ERROR',
            'since must be an ISO-8601 timestamp',
            { since }
          );
          return;
        }

        const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
        const limit = parseLimit(req.query.limit);

        const result = await deps.store.list(tenantId, {
          status: statusParam as WebhookDeliveryStatus | undefined,
          since,
          cursor,
          limit,
        });

        res.json({
          tenantId,
          items: result.items,
          nextCursor: result.nextCursor ?? null,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // POST /:tenantId/webhooks/deliveries/:batchId:replay
  //
  // Express treats `:` inside a path segment as part of the param token, so
  // we use a literal `:replay` suffix matched via a regex-style param.
  router.post(
    '/:tenantId/webhooks/deliveries/:batchId\\:replay',
    guard,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        const batchId = String(req.params.batchId ?? '');
        if (!tenantId || !batchId) {
          sendError(res, 400, 'VALIDATION_ERROR', 'tenantId and batchId are required');
          return;
        }

        const existing = await deps.store.get(tenantId, batchId);
        if (!existing) {
          sendError(res, 404, 'NOT_FOUND', 'Delivery record not found');
          return;
        }

        if (!deps.sink) {
          sendError(
            res,
            503,
            'REPLAY_UNAVAILABLE',
            'Webhook sink is not configured for replay'
          );
          return;
        }

        const cached = deps.sink.getCachedBatch(batchId);
        if (!cached) {
          // Bodies are not persisted (privacy/cost); outside the in-flight
          // cache window we cannot reconstruct the batch.
          sendError(
            res,
            410,
            'BATCH_BODY_EXPIRED',
            'Original batch payload is no longer in the replay cache'
          );
          return;
        }

        // Fire-and-await — the sink's own concurrency guard makes a second\n        // overlapping replay a no-op (idempotency by batchId).
        const updated = await deps.sink.replayBatch(cached, batchId);
        res.json({
          tenantId,
          batchId,
          replayed: true,
          delivery: updated ?? existing,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
