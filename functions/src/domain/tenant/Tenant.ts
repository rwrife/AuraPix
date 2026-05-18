/**
 * Tenant domain primitives.
 *
 * A "tenant" represents a host application's customer / billing account.
 * AuraPix is designed to be embedded inside host applications, each of which
 * may serve many of its own customers. Every long-lived resource (library,
 * album, photo, upload session, future metering event) is stamped with a
 * stable {@link TenantId} so the host can:
 *   - attribute usage / quotas / billing per customer,
 *   - safely enumerate / delete a customer's data on offboarding,
 *   - partition metering events.
 *
 * See `docs/architecture/tenant-model.md` for the ADR.
 */

export type TenantId = string;

/**
 * Default tenant used when no tenant context has been resolved. Existing
 * single-tenant deployments and the backfill script both rely on this value,
 * so it MUST remain stable.
 */
export const DEFAULT_TENANT_ID: TenantId = 'default';

/**
 * Header used by host applications to forward the tenant identifier through
 * the existing signed-auth path. The middleware only trusts this header when
 * a signed/authenticated upstream has set it.
 */
export const TENANT_HEADER = 'x-aurapix-tenant-id';

const TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Returns true if `value` is a syntactically valid tenant id. Tenant ids are
 * intentionally restricted to URL-safe characters so they can appear in
 * storage paths, Firestore field values, and metering partition keys without
 * additional encoding.
 */
export function isValidTenantId(value: unknown): value is TenantId {
  return typeof value === 'string' && TENANT_ID_PATTERN.test(value);
}

/**
 * Normalizes a tenant id from an untrusted source. Returns `null` when the
 * input is not a valid tenant id; callers should fall back to
 * {@link DEFAULT_TENANT_ID} or reject the request as appropriate.
 */
export function normalizeTenantId(value: unknown): TenantId | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isValidTenantId(trimmed) ? trimmed : null;
}

/**
 * Error thrown when a caller attempts to mutate or read a resource that
 * belongs to a different tenant. Surfaces as HTTP 403 via the error handler.
 */
export class CrossTenantAccessError extends Error {
  public readonly status = 403;
  public readonly code = 'cross-tenant-access';

  constructor(
    public readonly resourceTenantId: TenantId,
    public readonly callerTenantId: TenantId
  ) {
    super(
      `Cross-tenant access denied: caller tenant "${callerTenantId}" cannot access resource owned by tenant "${resourceTenantId}".`
    );
    this.name = 'CrossTenantAccessError';
  }
}

/**
 * Throws {@link CrossTenantAccessError} when the caller's tenant does not
 * match the resource's tenant. Resources whose `tenantId` is missing (legacy
 * documents written before tenant stamping rolled out) are treated as
 * belonging to {@link DEFAULT_TENANT_ID} so existing data keeps working.
 */
export function assertSameTenant(
  resourceTenantId: TenantId | undefined | null,
  callerTenantId: TenantId
): void {
  const resolved = resourceTenantId ?? DEFAULT_TENANT_ID;
  if (resolved !== callerTenantId) {
    throw new CrossTenantAccessError(resolved, callerTenantId);
  }
}
