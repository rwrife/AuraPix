import type { Request, Response, NextFunction } from 'express';
import {
  DEFAULT_TENANT_ID,
  TENANT_HEADER,
  normalizeTenantId,
  type TenantId,
} from '../domain/tenant/Tenant.js';
import { logger } from '../utils/logger.js';

// Augment Express Request with the resolved tenant id.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantId?: TenantId;
    }
  }
}

/**
 * Auth-token claim shape used by a host-issued API key. Not yet emitted by
 * the auth pipeline, but reserved so the resolution order is forward
 * compatible.
 */
interface TenantClaimCarrier {
  tenantId?: unknown;
  tenant_id?: unknown;
}

function readClaimTenant(req: Request): TenantId | null {
  const user = (req as Request & { user?: TenantClaimCarrier }).user;
  if (!user) return null;
  return (
    normalizeTenantId(user.tenantId) ?? normalizeTenantId(user.tenant_id)
  );
}

function readHeaderTenant(req: Request): TenantId | null {
  const raw = req.headers[TENANT_HEADER];
  if (Array.isArray(raw)) return normalizeTenantId(raw[0]);
  return normalizeTenantId(raw);
}

/**
 * Resolves the tenant id for the current request and attaches it to
 * `req.tenantId`. Resolution order:
 *   1. Authenticated claim (`req.user.tenantId`) — set by a future host
 *      API-key issuer.
 *   2. `X-AuraPix-Tenant-Id` request header — only meaningful when the
 *      caller has already passed the existing auth middleware.
 *   3. {@link DEFAULT_TENANT_ID} — backwards-compatible fallback for
 *      single-tenant deployments.
 *
 * This middleware is intentionally non-failing: callers without a tenant
 * context still get the default tenant. Cross-tenant enforcement is the
 * responsibility of the service layer via `assertSameTenant`.
 */
export function resolveTenant(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const claimTenant = readClaimTenant(req);
  if (claimTenant) {
    req.tenantId = claimTenant;
    logger.debug({ tenantId: claimTenant, source: 'claim' }, 'Tenant resolved');
    next();
    return;
  }

  const headerTenant = readHeaderTenant(req);
  if (headerTenant) {
    req.tenantId = headerTenant;
    logger.debug({ tenantId: headerTenant, source: 'header' }, 'Tenant resolved');
    next();
    return;
  }

  req.tenantId = DEFAULT_TENANT_ID;
  next();
}

/**
 * Convenience accessor used by handlers/services. Returns the resolved
 * tenant id, falling back to {@link DEFAULT_TENANT_ID} if `resolveTenant`
 * has not run (e.g., internal/background jobs).
 */
export function getRequestTenantId(req: Request): TenantId {
  return req.tenantId ?? DEFAULT_TENANT_ID;
}
