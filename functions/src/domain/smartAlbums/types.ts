/**
 * Smart Albums — saved filter queries that materialize on read.
 *
 * Issue #165. A Smart Album is a *named, validated filter* (DSL) over photos
 * scoped to a single library + tenant. Unlike regular albums (which are
 * manual collections of photo ids), a Smart Album has *no* explicit photo
 * membership — it materializes by re-running the filter against the
 * `photos` collection at read time.
 *
 * The DSL is intentionally tiny and closed-set:
 *   - `rating?: { gte?: number; lte?: number }`
 *   - `flag?: 'pick' | 'reject'`
 *   - `tags?: string[]`            (matched ANY: photo has at least one)
 *   - `capturedBetween?: [iso,iso]` (inclusive on metadata.takenAt)
 *   - `mimeTypes?: string[]`       (matched ANY against metadata.mimeType)
 *
 * The validator hard-rejects unknown keys to prevent query injection across
 * tenants; the filter is later re-validated at materialization time so a
 * stored bad filter (e.g., from a future schema version) cannot crash a
 * read.
 */

import type { TenantId } from '../tenant/Tenant.js';
import { DEFAULT_TENANT_ID } from '../tenant/Tenant.js';

/**
 * Validated Smart Album filter DSL. Every field is optional; an empty
 * object is a "match everything in the library" filter.
 */
export interface SmartAlbumFilter {
  rating?: { gte?: number; lte?: number };
  flag?: 'pick' | 'reject';
  tags?: string[];
  capturedBetween?: [string, string];
  mimeTypes?: string[];
}

/**
 * Stored Smart Album document.
 */
export interface SmartAlbum {
  id: string;
  tenantId: TenantId;
  libraryId: string;
  ownerId: string;
  name: string;
  filter: SmartAlbumFilter;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSmartAlbumInput {
  libraryId: string;
  ownerId: string;
  tenantId?: TenantId;
  name: string;
  filter: SmartAlbumFilter;
}

export interface UpdateSmartAlbumInput {
  name?: string;
  filter?: SmartAlbumFilter;
}

/**
 * Per-tenant cap to bound Firestore cost. Hard-coded; can be lifted to
 * configuration later.
 */
export const SMART_ALBUMS_PER_LIBRARY_CAP = 200;

export { DEFAULT_TENANT_ID };
export type { TenantId };
