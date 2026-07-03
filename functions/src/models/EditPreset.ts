/**
 * Per-tenant edit presets — "develop presets" / Lightroom Sync Settings
 * (issue #197).
 *
 * A photographer working in a tenant edits ONE photo (adjust exposure, apply
 * a crop, set a filter), then saves the resulting edit recipe as a named
 * preset and applies it across a selection of other photos from the same
 * shoot. This is the single most common Lightroom workflow AuraPix's edit
 * pipeline was missing.
 *
 * Storage shape: one document per preset under
 * `tenantEditPresets/{tenantId__presetId}`. Composite ids keep the data
 * partitioned by tenant while remaining easy to query with the flat
 * key/value adapter (LocalJsonData, FirestoreData). A first-class
 * `tenantId` field on every record supports the equality-query used by
 * offboarding / listing.
 *
 * The recipe is the exact same JSON blob the edit pipeline already
 * consumes on `POST /edits/:libraryId/:photoId` — no new processing
 * path is introduced. Apply-time enforcement (per-tenant plugin
 * allowlist, recipe version check, operation validation) happens at
 * commit-time in the shared executor.
 *
 * Multi-tenant hard rules:
 *   - Presets are STRICTLY tenant-scoped. Never global. Never cross-tenant.
 *   - Apply-time cross-tenant photoIds return HTTP 400 for the whole batch.
 *   - Per-tenant preset count is capped at 500 to bound storage.
 */

import type { EditOperation } from './Photo.js';

/**
 * Recipe format stored on a preset. Matches the shape validated by
 * `ApplyEditsSchema` in `utils/validation.ts` — the same executor
 * consumes both, so callers get identical semantics whether they apply
 * a recipe inline or via a preset.
 */
export interface EditPresetRecipe {
  /** Contract version, currently `1`. See EDIT_RECIPE_VERSION. */
  recipeVersion: number;
  /** Ordered list of edit operations. */
  operations: EditOperation[];
  /**
   * Optional free-form description carried onto every edit version
   * committed via this preset. Kept small; the DB does not truncate.
   */
  description?: string;
}

/**
 * A saved preset. Stored at `tenantEditPresets/{tenantId}__{presetId}`.
 */
export interface EditPresetRecord {
  /** Preset id (UUID). Doubles as the URL segment. */
  id: string;
  /** Tenant that owns the preset. Enforced on read + write. */
  tenantId: string;
  /** Human-readable name shown in the "Sync Settings" menu. 1–120 chars. */
  name: string;
  /** The recipe JSON applied at apply-time. */
  recipe: EditPresetRecipe;
  /**
   * Principal that created the preset. Either a user uid or a host API
   * key id (`tak_...`). Null for legacy records written before this
   * field existed (there are none today).
   */
  createdBy: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-modified timestamp. */
  updatedAt: string;
}

/**
 * Flat collection name (LocalJsonData / FirestoreData both use the flat
 * key/value shape from `DataAdapter`). Composite ids namespace records
 * per tenant.
 */
export const EDIT_PRESETS_COLLECTION = 'tenantEditPresets';

/**
 * Build the composite document id used to store a preset in the flat
 * key/value adapter. Format: `{tenantId}__{presetId}`.
 *
 * Mirrors the pattern used by `tenantMemberDocId` — keeps records
 * partitioned per tenant without requiring a nested-collection API on
 * the adapter interface.
 */
export function editPresetDocId(tenantId: string, presetId: string): string {
  return `${tenantId}__${presetId}`;
}

/**
 * Maximum number of presets per tenant. Bounds storage so a runaway
 * host cannot fill Firestore with millions of tiny recipe docs. When a
 * tenant hits the cap the create endpoint returns HTTP 409 with code
 * `EDIT_PRESET_CAP_EXCEEDED`.
 */
export const EDIT_PRESET_MAX_PER_TENANT = 500;

/**
 * Maximum number of photoIds accepted in a single apply batch. Matches
 * the bulk photo ops cap from issue #142 so hosts have one number to
 * remember across the surface.
 */
export const EDIT_PRESET_APPLY_MAX_PHOTO_IDS = 200;

/** Bounds on the human-readable preset name. */
export const EDIT_PRESET_NAME_MIN_LENGTH = 1;
export const EDIT_PRESET_NAME_MAX_LENGTH = 120;
