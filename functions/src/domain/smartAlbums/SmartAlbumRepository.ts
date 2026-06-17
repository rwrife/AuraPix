import type {
  CreateSmartAlbumInput,
  SmartAlbum,
  UpdateSmartAlbumInput,
} from './types.js';
import type { TenantId } from '../tenant/Tenant.js';

/**
 * Persistence interface for Smart Albums (issue #165). Implementations are
 * tenant-aware; the service layer additionally enforces tenant scoping
 * through `assertSameTenant`.
 */
export interface SmartAlbumRepository {
  /** List smart albums for a (tenant, library) pair. */
  listByLibrary(tenantId: TenantId, libraryId: string): Promise<SmartAlbum[]>;

  /** Look up a smart album by id (returns null when missing). */
  getById(id: string): Promise<SmartAlbum | null>;

  /** Persist a new smart album document. */
  create(input: CreateSmartAlbumInput): Promise<SmartAlbum>;

  /** Update an existing smart album. Returns null when missing. */
  update(id: string, updates: UpdateSmartAlbumInput): Promise<SmartAlbum | null>;

  /** Delete a smart album by id. Returns true when a row was removed. */
  delete(id: string): Promise<boolean>;

  /**
   * Count smart albums for a (tenant, library) pair. Used by the per-tenant
   * cap; implementations may serve this from a counter doc when available.
   */
  countByLibrary(tenantId: TenantId, libraryId: string): Promise<number>;
}
