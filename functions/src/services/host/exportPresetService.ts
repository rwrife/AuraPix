/**
 * Service layer for per-tenant export presets (issue #174).
 *
 * A tenant's preset list is a single document under
 * `tenantExportPresets/{tenantId}`. Tenants without an explicit document
 * inherit `DEFAULT_EXPORT_PRESETS` (web-small / web-large / original).
 *
 * The host (via host API key) may CRUD presets to override the seeded
 * defaults — e.g. a free-plan tenant whose preset list contains only
 * `web-small`. End-user keys may **read** the preset list (so the
 * Lightroom-style export menu can be rendered) but cannot mutate it.
 */

import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import {
  DEFAULT_EXPORT_PRESETS,
  EXPORT_PRESET_MAX_EDGE,
  EXPORT_PRESET_MAX_QUALITY,
  EXPORT_PRESET_MIN_EDGE,
  EXPORT_PRESET_MIN_QUALITY,
  EXPORT_PRESET_NAME_PATTERN,
  TENANT_EXPORT_PRESETS_COLLECTION,
  defaultExportPresets,
  type ExportPreset,
  type TenantExportPresetsRecord,
} from '../../models/ExportPreset.js';

/**
 * Thrown by validation helpers when an incoming preset payload is
 * malformed. The route layer maps this to HTTP 400 with the same `code`.
 */
export class ExportPresetValidationError extends Error {
  public readonly status = 400;
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExportPresetValidationError';
    this.code = code;
  }
}

/**
 * Validates and normalizes the body of a `PUT /export-presets/:name`
 * request. The `name` from the URL is the source of truth; any `name`
 * field in the body is ignored so a caller cannot rename in-place via
 * the PUT path (which would silently leave the old preset behind).
 */
export function validatePresetBody(
  name: string,
  body: unknown
): ExportPreset {
  if (!EXPORT_PRESET_NAME_PATTERN.test(name)) {
    throw new ExportPresetValidationError(
      'INVALID_PRESET_NAME',
      `Preset name must match ${EXPORT_PRESET_NAME_PATTERN}`
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ExportPresetValidationError(
      'INVALID_REQUEST_BODY',
      'Request body must be a JSON object'
    );
  }
  const b = body as Record<string, unknown>;

  const format = b.format;
  if (format !== 'jpeg' && format !== 'original') {
    throw new ExportPresetValidationError(
      'INVALID_FORMAT',
      'format must be either "jpeg" or "original"'
    );
  }

  // For `original` we tolerate missing maxEdge/quality and substitute the
  // documented sensible defaults so the persisted record is uniform.
  const isOriginal = format === 'original';

  const maxEdgeRaw = b.maxEdge ?? (isOriginal ? EXPORT_PRESET_MAX_EDGE : undefined);
  if (
    typeof maxEdgeRaw !== 'number' ||
    !Number.isFinite(maxEdgeRaw) ||
    !Number.isInteger(maxEdgeRaw) ||
    maxEdgeRaw < EXPORT_PRESET_MIN_EDGE ||
    maxEdgeRaw > EXPORT_PRESET_MAX_EDGE
  ) {
    throw new ExportPresetValidationError(
      'INVALID_MAX_EDGE',
      `maxEdge must be an integer between ${EXPORT_PRESET_MIN_EDGE} and ${EXPORT_PRESET_MAX_EDGE}`
    );
  }

  const qualityRaw = b.quality ?? (isOriginal ? EXPORT_PRESET_MAX_QUALITY : undefined);
  if (
    typeof qualityRaw !== 'number' ||
    !Number.isFinite(qualityRaw) ||
    !Number.isInteger(qualityRaw) ||
    qualityRaw < EXPORT_PRESET_MIN_QUALITY ||
    qualityRaw > EXPORT_PRESET_MAX_QUALITY
  ) {
    throw new ExportPresetValidationError(
      'INVALID_QUALITY',
      `quality must be an integer between ${EXPORT_PRESET_MIN_QUALITY} and ${EXPORT_PRESET_MAX_QUALITY}`
    );
  }

  const label = b.label;
  if (label !== undefined && (typeof label !== 'string' || label.length > 128)) {
    throw new ExportPresetValidationError(
      'INVALID_LABEL',
      'label, when present, must be a string up to 128 characters'
    );
  }

  const preset: ExportPreset = {
    name,
    maxEdge: maxEdgeRaw,
    quality: qualityRaw,
    format,
    ...(typeof label === 'string' ? { label } : {}),
  };
  return preset;
}

/**
 * Fetch the raw preset document for a tenant, or null when none exists.
 * Most callers should use {@link getEffectivePresets} or
 * {@link getOrInitTenantExportPresets} instead — this is an escape hatch
 * for tooling that must distinguish "default seeded" from "explicitly set".
 */
export async function fetchTenantExportPresets(
  data: DataAdapter,
  tenantId: string
): Promise<TenantExportPresetsRecord | null> {
  if (!tenantId) return null;
  return data.fetchData<TenantExportPresetsRecord>(
    TENANT_EXPORT_PRESETS_COLLECTION,
    tenantId
  );
}

/**
 * Resolve the effective preset list for a tenant, applying the seeded
 * defaults when no explicit doc exists. Malformed persisted presets
 * (e.g. unknown fields) are filtered out defensively so a bad write
 * cannot serve a broken preset to a user.
 */
export async function getEffectivePresets(
  data: DataAdapter,
  tenantId: string
): Promise<ExportPreset[]> {
  const doc = await fetchTenantExportPresets(data, tenantId);
  if (!doc || !Array.isArray(doc.presets) || doc.presets.length === 0) {
    return defaultExportPresets();
  }
  return doc.presets
    .filter((p): p is ExportPreset => isValidPreset(p))
    .map((p) => ({ ...p }));
}

/**
 * Get the preset list, falling back to defaults; resolves a single
 * preset by name. Returns null if no preset matches. Used by the photo
 * export endpoint.
 */
export async function resolvePresetByName(
  data: DataAdapter,
  tenantId: string,
  name: string
): Promise<ExportPreset | null> {
  const list = await getEffectivePresets(data, tenantId);
  const match = list.find((p) => p.name === name);
  return match ? { ...match } : null;
}

/**
 * Read-or-initialize: returns the existing doc, or — when none exists —
 * a synthesized record built from the seeded defaults. The synthesized
 * record is NOT persisted (unlike the plugin-config equivalent) because
 * the seeded list is stable and reading should remain a pure read; the
 * first PUT will create the doc.
 */
export async function getOrInitTenantExportPresets(
  data: DataAdapter,
  tenantId: string
): Promise<TenantExportPresetsRecord> {
  const existing = await fetchTenantExportPresets(data, tenantId);
  if (existing) return existing;
  return {
    tenantId,
    presets: defaultExportPresets(),
    updatedAt: new Date(0).toISOString(),
    updatedBy: null,
  };
}

/**
 * Upsert a single preset for a tenant. If the doc does not yet exist it
 * is created from the seeded defaults and then mutated, so a host that
 * only overrides one preset (e.g. lowering `web-large` quality) keeps
 * the other defaults intact.
 *
 * Returns `{ record, changed }` — `changed` is false when the persisted
 * preset is byte-for-byte identical to the new one, so the route layer
 * can skip writes that would be no-ops.
 */
export async function setTenantExportPreset(
  data: DataAdapter,
  options: {
    tenantId: string;
    preset: ExportPreset;
    actor?: string | null;
  }
): Promise<{ record: TenantExportPresetsRecord; changed: boolean }> {
  const { tenantId, preset, actor } = options;
  if (!tenantId) {
    throw new Error('tenantId is required');
  }
  const existing = await fetchTenantExportPresets(data, tenantId);
  const current = existing
    ? existing.presets.filter(isValidPreset)
    : defaultExportPresets();

  const idx = current.findIndex((p) => p.name === preset.name);
  let changed = true;
  if (idx >= 0) {
    if (presetsEqual(current[idx]!, preset)) {
      changed = false;
    }
    current[idx] = preset;
  } else {
    current.push(preset);
  }

  if (!changed && existing) {
    return { record: existing, changed: false };
  }

  const now = new Date().toISOString();
  const record: TenantExportPresetsRecord = {
    tenantId,
    presets: current,
    updatedAt: now,
    updatedBy: actor ?? null,
  };
  await data.storeData(TENANT_EXPORT_PRESETS_COLLECTION, tenantId, record);
  return { record, changed };
}

/**
 * Delete a single preset by name. Returns `{ record, removed }` —
 * `removed` is false when the preset did not exist (idempotent delete).
 */
export async function deleteTenantExportPreset(
  data: DataAdapter,
  options: {
    tenantId: string;
    name: string;
    actor?: string | null;
  }
): Promise<{ record: TenantExportPresetsRecord; removed: boolean }> {
  const { tenantId, name, actor } = options;
  if (!tenantId) {
    throw new Error('tenantId is required');
  }
  const existing = await fetchTenantExportPresets(data, tenantId);
  const current = existing
    ? existing.presets.filter(isValidPreset)
    : defaultExportPresets();
  const idx = current.findIndex((p) => p.name === name);
  if (idx < 0) {
    // Nothing to remove. Avoid materializing a doc just for a no-op delete.
    const record: TenantExportPresetsRecord = existing ?? {
      tenantId,
      presets: current,
      updatedAt: new Date(0).toISOString(),
      updatedBy: null,
    };
    return { record, removed: false };
  }
  current.splice(idx, 1);
  const now = new Date().toISOString();
  const record: TenantExportPresetsRecord = {
    tenantId,
    presets: current,
    updatedAt: now,
    updatedBy: actor ?? null,
  };
  await data.storeData(TENANT_EXPORT_PRESETS_COLLECTION, tenantId, record);
  return { record, removed: true };
}

function isValidPreset(p: unknown): p is ExportPreset {
  if (!p || typeof p !== 'object') return false;
  const o = p as Partial<ExportPreset>;
  if (typeof o.name !== 'string' || !EXPORT_PRESET_NAME_PATTERN.test(o.name)) {
    return false;
  }
  if (o.format !== 'jpeg' && o.format !== 'original') return false;
  if (typeof o.maxEdge !== 'number' || !Number.isInteger(o.maxEdge)) return false;
  if (o.maxEdge < EXPORT_PRESET_MIN_EDGE || o.maxEdge > EXPORT_PRESET_MAX_EDGE) {
    return false;
  }
  if (typeof o.quality !== 'number' || !Number.isInteger(o.quality)) return false;
  if (o.quality < EXPORT_PRESET_MIN_QUALITY || o.quality > EXPORT_PRESET_MAX_QUALITY) {
    return false;
  }
  return true;
}

function presetsEqual(a: ExportPreset, b: ExportPreset): boolean {
  return (
    a.name === b.name &&
    a.maxEdge === b.maxEdge &&
    a.quality === b.quality &&
    a.format === b.format &&
    (a.label ?? null) === (b.label ?? null)
  );
}

/** Test/observability helper: stable list of seeded default names. */
export function defaultPresetNames(): string[] {
  return DEFAULT_EXPORT_PRESETS.map((p) => p.name);
}
