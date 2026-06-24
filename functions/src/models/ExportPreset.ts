/**
 * Per-tenant photo export presets (issue #174).
 *
 * A host application reselling AuraPix can offer end users a "Lightroom-
 * style" export at one of a small set of named presets (e.g.
 * `web-small`, `web-large`, `original`). Presets are tenant-scoped so the
 * host can gate which sizes a given tenant tier is allowed to render.
 *
 * Storage shape: one document per tenant under
 * `tenantExportPresets/{tenantId}` containing the full preset list. Using
 * tenantId as the document id keeps lookups O(1) and lets the host
 * atomically replace the whole list when a plan changes (e.g. free →
 * pro). Default-on behavior: tenants without an explicit document inherit
 * the seeded defaults below.
 *
 * The preset `name` doubles as the URL slug (e.g.
 * `PUT /tenants/:id/export-presets/web-small`) and as the cache key
 * partition so two different presets cannot collide in the rendered
 * cache.
 */

export const TENANT_EXPORT_PRESETS_COLLECTION = 'tenantExportPresets';

/**
 * Optional watermark configuration for an export preset (issue #185).
 *
 * Independent from share-link watermarking (#32/#46): hosts reselling
 * AuraPix for client-proofing want a per-preset watermark ("PROOF —
 * example.com") applied during the export pipeline. The renderer is
 * the same as share delivery via the shared `watermark` util.
 *
 * `text` may include the following non-PII tokens, substituted at
 * render time:
 *   - `{tenantName}` — branding `appName`, or the tenantId when unset
 *   - `{photoId}`    — the photo's id
 *   - `{date}`       — `YYYY-MM-DD` in UTC at render time
 *
 * `opacity` is the watermark layer opacity in `[0, 1]`. `position`
 * controls which corner the watermark anchors to.
 */
export interface ExportPresetWatermark {
  /** When false the watermark renderer is skipped entirely. */
  enabled: boolean;
  /**
   * Display text. Up to 256 characters after token substitution; must
   * be non-empty when `enabled` is true. Tokens not in the allowlist
   * are passed through verbatim (no error) so a host can include
   * literal `{` characters in their watermark.
   */
  text: string;
  /** Opacity in `[0, 1]`. Validated; out-of-range values are rejected. */
  opacity: number;
  /** Anchor corner for the watermark layer. */
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

/**
 * Allowed `position` values for an export-preset watermark. Mirrors the
 * `ExportPresetWatermark.position` union so the validator can iterate
 * without re-declaring the literal list.
 */
export const EXPORT_PRESET_WATERMARK_POSITIONS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

export type ExportPresetWatermarkPosition =
  (typeof EXPORT_PRESET_WATERMARK_POSITIONS)[number];

/** Max length of the (pre-substitution) watermark text. */
export const EXPORT_PRESET_WATERMARK_MAX_TEXT_LENGTH = 256;

/**
 * A single named export preset. `format` is either `jpeg` (default,
 * matches the issue: rendered JPEG output) or `original` (no transcode,
 * stream the bytes already on disk). Sizes are an upper bound — the
 * processor uses `fit: 'inside'` semantics so a small input is not
 * upscaled.
 */
export interface ExportPreset {
  /**
   * URL-safe identifier; doubles as the cache partition key. Matches
   * `^[a-z0-9][a-z0-9-]{0,31}$` so it can appear in paths and Firestore
   * field values without additional encoding.
   */
  name: string;
  /**
   * Maximum edge in pixels. Ignored when `format === 'original'`.
   * Must be an integer between 1 and 8192.
   */
  maxEdge: number;
  /**
   * JPEG quality 1-100. Ignored when `format === 'original'`.
   */
  quality: number;
  /**
   * Output format. `original` returns the stored original bytes
   * unchanged (no recompression, no resize).
   *
   * NOTE: `watermark` is ignored when `format === 'original'` because
   * passthrough delivery must not modify the source bytes (a host that
   * needs a watermarked original should ship a separate JPEG preset).
   */
  format: 'jpeg' | 'original';
  /**
   * Optional human-readable label shown in host admin UI.
   */
  label?: string;
  /**
   * Optional watermark configuration (issue #185). Missing means "no
   * watermark" — semantically identical to `{ enabled: false }`.
   * Ignored when `format === 'original'`.
   */
  watermark?: ExportPresetWatermark;
}

export interface TenantExportPresetsRecord {
  /** Document id; equal to `tenantId`. */
  tenantId: string;
  /** Ordered preset list. Names are unique within the list. */
  presets: ExportPreset[];
  /** ISO-8601 timestamp of the last mutation. */
  updatedAt: string;
  /**
   * Identifier of the principal that last updated the doc (host API key
   * id, e.g. `tak_...`). Null for system-initialized (seeded) records.
   */
  updatedBy: string | null;
}

/**
 * Seeded default presets used when a tenant has no explicit document.
 * Order matches the issue: `web-small`, `web-large`, `original`.
 */
export const DEFAULT_EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    name: 'web-small',
    maxEdge: 1280,
    quality: 80,
    format: 'jpeg',
    label: 'Web (small)',
  },
  {
    name: 'web-large',
    maxEdge: 2048,
    quality: 85,
    format: 'jpeg',
    label: 'Web (large)',
  },
  {
    name: 'original',
    // maxEdge / quality are ignored for `original`; store sensible
    // values so a tenant overriding the format later still has them.
    maxEdge: 8192,
    quality: 100,
    format: 'original',
    label: 'Original',
  },
] as const;

export const EXPORT_PRESET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const EXPORT_PRESET_MAX_EDGE = 8192;
export const EXPORT_PRESET_MIN_EDGE = 1;
export const EXPORT_PRESET_MIN_QUALITY = 1;
export const EXPORT_PRESET_MAX_QUALITY = 100;

/**
 * Return a fresh copy of the seeded defaults so callers cannot mutate
 * the shared array.
 */
export function defaultExportPresets(): ExportPreset[] {
  return DEFAULT_EXPORT_PRESETS.map((p) => ({ ...p }));
}
