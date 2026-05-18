import { DEFAULT_TENANT_ID, type TenantId } from '../tenant/Tenant.js';

export interface Album {
  id: string;
  ownerId: string;
  /**
   * Host-customer / billing tenant that owns this album. Optional on the
   * type for backwards compatibility with documents written before the
   * tenant rollout — treat a missing value as {@link DEFAULT_TENANT_ID}.
   */
  tenantId?: TenantId;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAlbumInput {
  ownerId: string;
  tenantId?: TenantId;
  title: string;
  description?: string;
}

export { DEFAULT_TENANT_ID };
export type { TenantId };
