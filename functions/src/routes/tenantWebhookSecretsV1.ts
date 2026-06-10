/**
 * Tenant webhook signing-secret rotation API (issue #161).
 *
 * Endpoints (mounted under `/api/v1/tenants`):
 *
 *   POST /:tenantId/webhooks/rotate-secret
 *     Mint a new signing secret. Returns the plaintext exactly once and
 *     keeps the previous secret valid for a grace window (default 24h,
 *     capped 7d) so receivers can validate either signature during cut-over.
 *
 *   GET  /:tenantId/webhooks/secret
 *     Return metadata only (created_at, fingerprint, rotated_at, optional
 *     `previous` block with `expiresAt`). NEVER returns the plaintext.
 *
 * Both endpoints require a host API key with the `webhooks.write` scope
 * (issuing a write _or_ reading current secret metadata are equally
 * sensitive surfaces).
 *
 * On rotate, the route emits a `webhook.secret_rotated` metering event so
 * the host can audit rotations via the existing metering pipeline.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { requireUserOrTenantScopes } from '../middleware/hostApiKeyAuth.js';
import {
  MAX_ROTATION_GRACE_SECONDS,
  DEFAULT_ROTATION_GRACE_SECONDS,
} from '../models/TenantWebhookSecret.js';
import {
  getTenantWebhookSecretMetadata,
  rotateTenantWebhookSecret,
} from '../services/host/tenantWebhookSecretService.js';
import type { MeteringBus } from '../services/metering/MeteringBus.js';

export interface TenantWebhookSecretsRouterDeps {
  dataAdapter: DataAdapter;
  /**
   * Optional metering bus used to emit the `webhook.secret_rotated` event
   * after a successful rotation. When omitted (tests / dev), the event is
   * silently skipped.
   */
  meteringBus?: Pick<MeteringBus, 'emit'>;
  /** Test hook for time. */
  now?: () => Date;
}

interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: Record<string, unknown> | null;
  };
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> | null = null
): void {
  const payload: ApiErrorPayload = {
    error: {
      code,
      message,
      requestId: randomUUID(),
      details,
    },
  };
  res.status(status).json(payload);
}

function parseGraceSeconds(value: unknown): number | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  if (n > MAX_ROTATION_GRACE_SECONDS) return 'invalid';
  return Math.floor(n);
}

export function createTenantWebhookSecretsRouter(
  deps: TenantWebhookSecretsRouterDeps
): Router {
  const router = Router({ mergeParams: true });

  const tenantFromParams = (req: Request): string | undefined =>
    req.params.tenantId ? String(req.params.tenantId) : undefined;

  const guard = requireUserOrTenantScopes({
    scopes: ['webhooks.write'],
    tenantIdFromReq: tenantFromParams,
  });

  // POST /:tenantId/webhooks/rotate-secret
  router.post(
    '/:tenantId/webhooks/rotate-secret',
    guard,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        if (!tenantId) {
          sendError(res, 400, 'VALIDATION_ERROR', 'tenantId is required');
          return;
        }
        const body = (req.body ?? {}) as { graceSeconds?: unknown };
        const grace = parseGraceSeconds(body.graceSeconds);
        if (grace === 'invalid') {
          sendError(
            res,
            400,
            'VALIDATION_ERROR',
            `graceSeconds must be a non-negative integer <= ${MAX_ROTATION_GRACE_SECONDS}`,
            { graceSeconds: body.graceSeconds }
          );
          return;
        }
        const result = await rotateTenantWebhookSecret(
          deps.dataAdapter,
          tenantId,
          {
            graceSeconds: grace,
            now: deps.now,
          }
        );

        // Best-effort metering event. The bus contract is fire-and-forget
        // and never throws, so we don't gate the response on it.
        if (deps.meteringBus) {
          try {
            deps.meteringBus.emit({
              tenantId,
              type: 'webhook.secret_rotated',
              count: 1,
              occurredAt: result.record.rotatedAt,
              meta: {
                rotatedAt: result.record.rotatedAt,
                graceWindowSeconds:
                  grace ?? DEFAULT_ROTATION_GRACE_SECONDS,
                fingerprintNew: result.record.current.fingerprint,
                fingerprintOld:
                  result.record.previous?.fingerprint ?? null,
              },
            });
          } catch {
            // Metering is best-effort.
          }
        }

        res.status(200).json({
          tenantId,
          secret: result.plaintextSecret,
          fingerprint: result.record.current.fingerprint,
          createdAt: result.record.current.createdAt,
          rotatedAt: result.record.rotatedAt,
          rotatesAt: result.rotatesAt,
          previous: result.record.previous
            ? {
                fingerprint: result.record.previous.fingerprint,
                createdAt: result.record.previous.createdAt,
                expiresAt: result.record.previousExpiresAt,
              }
            : null,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // GET /:tenantId/webhooks/secret  (metadata only)
  router.get(
    '/:tenantId/webhooks/secret',
    guard,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantId = String(req.params.tenantId ?? '');
        if (!tenantId) {
          sendError(res, 400, 'VALIDATION_ERROR', 'tenantId is required');
          return;
        }
        const meta = await getTenantWebhookSecretMetadata(
          deps.dataAdapter,
          tenantId,
          { now: deps.now }
        );
        if (!meta) {
          sendError(
            res,
            404,
            'NOT_FOUND',
            'No webhook signing secret has been minted for this tenant'
          );
          return;
        }
        res.status(200).json(meta);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
