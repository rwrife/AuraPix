import type { Request, Response, NextFunction } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import {
  authenticatePlaintextKey,
  touchTenantApiKey,
} from '../services/host/tenantApiKeyService.js';
import type { TenantApiKeyScope } from '../models/TenantApiKey.js';
import { logger } from '../utils/logger.js';

export interface AuthenticatedTenantContext {
  id: string;
  scopes: TenantApiKeyScope[];
  keyId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Present when the request was authenticated via a host API key
       * (Authorization: Bearer ak_live_...). Mutually exclusive with `user`
       * in practice, though both can be checked independently.
       */
      tenant?: AuthenticatedTenantContext;
    }
  }
}

const KEY_PREFIX = 'ak_live_';

/**
 * Lightweight metering hook — sampled and best-effort. The host can audit
 * which integrations are active via these logs. (See issue #131,
 * `metering.key.used`.) Sampled at ~10% to keep log volume bounded.
 */
function emitKeyUsedMetric(ctx: AuthenticatedTenantContext, path: string): void {
  if (Math.random() < 0.1) {
    logger.info(
      { event: 'metering.key.used', tenantId: ctx.id, keyId: ctx.keyId, path },
      'host api key used'
    );
  }
}

/**
 * Express middleware that authenticates a request using a per-tenant host
 * API key in the form `Authorization: Bearer ak_live_...`.
 *
 * Behavior:
 *  - If no Bearer token is present, or the token does not look like a host
 *    API key, the middleware is a no-op and forwards to `next()`. This lets
 *    the same route be composed with other auth strategies (e.g. a Firebase
 *    user token via `authMiddleware`).
 *  - If a key-shaped token is present but invalid (unknown prefix, hash
 *    mismatch, or revoked), responds with 401.
 *  - On success, sets `req.tenant = { id, scopes, keyId }` and continues.
 *
 * Hash compare is constant-time. Revoked keys are rejected. `lastUsedAt` is
 * updated best-effort and any write error is swallowed.
 */
export function createHostApiKeyAuth(dataAdapter: DataAdapter) {
  return async function hostApiKeyAuth(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      next();
      return;
    }
    const token = header.substring('Bearer '.length).trim();
    if (!token.startsWith(KEY_PREFIX)) {
      // Not a host API key — let the next auth middleware handle it.
      next();
      return;
    }
    try {
      const authed = await authenticatePlaintextKey(dataAdapter, token);
      if (!authed) {
        res.status(401).json({ error: 'Invalid or revoked host API key' });
        return;
      }
      const ctx: AuthenticatedTenantContext = {
        id: authed.record.tenantId,
        scopes: authed.record.scopes,
        keyId: authed.record.id,
      };
      req.tenant = ctx;
      emitKeyUsedMetric(ctx, req.path);
      // Best-effort lastUsedAt update; never block the request on it.
      void touchTenantApiKey(dataAdapter, authed.record.id).catch((err) => {
        logger.debug({ err, keyId: authed.record.id }, 'Failed to update lastUsedAt');
      });
      next();
    } catch (err) {
      logger.error({ err }, 'Host API key authentication failed');
      res.status(401).json({ error: 'Host API key authentication failed' });
    }
  };
}

/**
 * Route guard: allow either an authenticated user (set by `authMiddleware`)
 * OR an authenticated host API key carrying ALL of the required scopes for
 * the tenant that owns the resource.
 *
 * `tenantIdFromReq` extracts the tenant context that owns the target
 * resource. If the call is key-authenticated but `req.tenant.id` does not
 * match, this returns 403 (cross-tenant rejection).
 *
 * If neither auth source is present, responds with 401.
 */
export function requireUserOrTenantScopes(options: {
  scopes: TenantApiKeyScope[];
  tenantIdFromReq?: (req: Request) => string | undefined;
}) {
  const { scopes, tenantIdFromReq } = options;
  return function guard(req: Request, res: Response, next: NextFunction): void {
    if (req.tenant) {
      const tenantId = tenantIdFromReq ? tenantIdFromReq(req) : undefined;
      if (tenantId && tenantId !== req.tenant.id) {
        res.status(403).json({ error: 'Cross-tenant request rejected' });
        return;
      }
      const granted = new Set(req.tenant.scopes);
      const missing = scopes.filter((s) => !granted.has(s));
      if (missing.length > 0) {
        res.status(403).json({
          error: 'Insufficient scope',
          missing,
        });
        return;
      }
      next();
      return;
    }
    if (req.user) {
      next();
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  };
}
