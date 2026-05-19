/**
 * Library domain model with ownership tracking
 */

import { DEFAULT_TENANT_ID, type TenantId } from '../domain/tenant/Tenant.js';

export interface Library {
  id: string;
  userId: string;         // Owner user ID
  /**
   * Host-customer / billing tenant that owns this library. Optional on the
   * type for backwards compatibility with documents written before the
   * tenant rollout — treat a missing value as {@link DEFAULT_TENANT_ID}.
   */
  tenantId?: TenantId;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create a new library document
 */
export function createLibrary(
  id: string,
  userId: string,
  tenantId: TenantId = DEFAULT_TENANT_ID
): Library {
  const now = new Date().toISOString();
  return {
    id,
    userId,
    tenantId,
    createdAt: now,
    updatedAt: now,
  };
}
