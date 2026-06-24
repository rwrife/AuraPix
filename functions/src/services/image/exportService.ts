/**
 * Photo export pipeline (issue #174).
 *
 * Renders a finished photo at a named preset (size + quality), caches the
 * output keyed by `(photoId, recipeHash, presetName)`, and emits the
 * `photo.exported` metering event. Reuses:
 *   - `applyEdits` for the active edit recipe
 *   - `generateHighQualityJpeg` semantics for resize + JPEG encode
 *   - `MeteringBus` for billable events
 *   - The same HMAC primitives (`signData`/`verifySignature`) used by
 *     the existing image signing pipeline
 *
 * A short-lived signed URL is returned to the caller; the URL points at
 * `GET /v1/photos/:id/export/:token` which streams the cached bytes.
 */

import { createHash, createHmac } from 'node:crypto';
import sharp from 'sharp';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import type { Photo } from '../../models/Photo.js';
import type { ExportPreset, ExportPresetWatermark } from '../../models/ExportPreset.js';
import { applyEdits } from '../edits/EditProcessor.js';
import { signingConfig } from '../../config/index.js';
import { signData, verifySignature } from '../../utils/crypto.js';
import { renderWatermark } from '../watermark/index.js';

/**
 * Local re-declaration of the branding-doc shape used for `{tenantName}`
 * substitution. Kept here — rather than importing from
 * `routes/brandingV1.ts` — to avoid pulling express + zod into the
 * services layer for a single string lookup.
 */
const BRANDING_COLLECTION = 'tenants_branding';
interface BrandingDoc {
  appName?: string;
}

/**
 * Result of rendering a photo to an export preset.
 *
 * `cacheHit` is forwarded to the metering layer so hosts can choose to
 * discount cached re-downloads even though we still emit one event per
 * call (matches the issue's acceptance criteria).
 */
export interface RenderedExport {
  buffer: Buffer;
  outputBytes: number;
  outputWidth: number;
  outputHeight: number;
  cacheHit: boolean;
  cacheKey: string;
  /**
   * True when the rendered bytes had a watermark composited on them
   * (issue #185). Forwarded to the metering layer as `meta.watermark`
   * so hosts can price watermarked vs clean exports differently.
   */
  watermarkApplied: boolean;
}

/**
 * Storage path for cached export bytes. We keep these under a dedicated
 * `exports/` prefix so they are easy to purge separately from
 * thumbnails. `cacheKey` already encodes `(photoId, recipeHash, preset)`
 * so a recipe change automatically produces a fresh cache miss.
 */
function cacheStoragePath(libraryId: string, cacheKey: string): string {
  return `exports/${libraryId}/${cacheKey}`;
}

/**
 * Stable hash of the active edit recipe. We hash the entire recipe
 * (operations + version) so a re-ordering or parameter change yields a
 * fresh cache key even at the same `currentEditVersion`.
 */
export function computeRecipeHash(photo: Photo): string {
  const version = photo.currentEditVersion ?? 0;
  if (version <= 0) {
    return `v0`;
  }
  const current = (photo.editHistory ?? []).find((e) => e.version === version);
  if (!current) {
    return `v${version}`;
  }
  // Sort operations by `order` so the hash is stable regardless of how
  // they were appended.
  const ops = [...(current.operations ?? [])].sort(
    (a, b) => a.order - b.order
  );
  const payload = JSON.stringify({
    version,
    recipeVersion: current.recipeVersion,
    operations: ops,
  });
  const digest = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  return `v${version}-${digest}`;
}

/**
 * Composite cache key: `(photoId, recipeHash, preset[, watermarkHash])`.
 *
 * When the preset declares an enabled watermark we include a short
 * hash of the watermark config so changing the watermark text/opacity/
 * position automatically produces a cache miss — otherwise we'd keep
 * serving the previously-watermarked bytes after a host updated the
 * preset. Presets without a watermark keep the original key shape so
 * pre-#185 cache entries remain valid.
 */
export function computeCacheKey(
  photoId: string,
  recipeHash: string,
  presetName: string,
  watermark?: ExportPresetWatermark
): string {
  if (watermark && watermark.enabled) {
    const wmHash = computeWatermarkHash(watermark);
    return `${photoId}.${recipeHash}.${presetName}.wm-${wmHash}.jpg`;
  }
  return `${photoId}.${recipeHash}.${presetName}.jpg`;
}

/**
 * Short stable hash of the watermark config used to partition the
 * export cache. Exported for tests.
 */
export function computeWatermarkHash(watermark: ExportPresetWatermark): string {
  // Stringify with a stable property order; watermark only has four
  // documented fields so we don't need a deep sort.
  const payload = JSON.stringify({
    enabled: watermark.enabled,
    text: watermark.text,
    opacity: watermark.opacity,
    position: watermark.position,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 12);
}

/**
 * Resolve the storage path holding the photo's original bytes. Falls
 * back to the legacy single `storagePath` field for pre-storagePaths
 * uploads.
 */
function originalStoragePath(photo: Photo): string {
  if (photo.storagePaths?.original) return photo.storagePaths.original;
  if (typeof photo.storagePath === 'string') return photo.storagePath;
  throw new Error(`Photo ${photo.id} has no original storage path`);
}

/**
 * Strip a `gs://bucket-name/` prefix if present so the storage adapter
 * sees a relative key (matches `serve.ts`).
 */
function normalize(path: string): string {
  return path.replace(/^gs:\/\/[^/]+\//, '');
}

/**
 * Render a photo to a single export preset, using the cache when
 * possible. The caller is responsible for tenant + auth checks.
 *
 * For `preset.format === 'original'` we serve the original bytes
 * unchanged (no resize, no transcode, no watermark — see
 * `ExportPreset.watermark`). For `jpeg` we apply the active edit
 * recipe, resize/encode via the existing Sharp pipeline, and
 * (when enabled on the preset) composite a watermark over the
 * resulting JPEG using the shared `renderWatermark` util.
 *
 * Pass `data` so the renderer can resolve `{tenantName}` from the
 * tenant's branding doc; without it the token substitutes to an empty
 * string.
 */
export async function renderExport(opts: {
  storage: StorageAdapter;
  photo: Photo;
  preset: ExportPreset;
  /**
   * Optional data adapter used to fetch the tenant branding doc when
   * substituting `{tenantName}` in a watermark template. When omitted
   * the token falls back to the tenantId.
   */
  data?: DataAdapter;
}): Promise<RenderedExport> {
  const { storage, photo, preset, data } = opts;
  const recipeHash = computeRecipeHash(photo);
  const watermarkActive =
    preset.format === 'jpeg' &&
    preset.watermark !== undefined &&
    preset.watermark.enabled;
  const cacheKey = computeCacheKey(
    photo.id,
    recipeHash,
    preset.name,
    watermarkActive ? preset.watermark : undefined
  );
  const cachePath = cacheStoragePath(photo.libraryId, cacheKey);

  // 1. Cache lookup (works for both formats).
  const cached = await tryReadCache(storage, cachePath);
  if (cached) {
    // The width/height are not stored in the cache; probe them with
    // Sharp.metadata() so the metering event still has accurate dims.
    const meta = await sharp(cached).metadata();
    return {
      buffer: cached,
      outputBytes: cached.length,
      outputWidth: meta.width ?? 0,
      outputHeight: meta.height ?? 0,
      cacheHit: true,
      cacheKey,
      watermarkApplied: watermarkActive,
    };
  }

  // 2. Render fresh.
  const sourcePath = normalize(originalStoragePath(photo));
  const sourceBuffer = await storage.readFile(sourcePath);

  let outputBuffer: Buffer;
  let width: number;
  let height: number;

  if (preset.format === 'original') {
    // `original` format intentionally skips watermarking: passthrough
    // delivery must not modify the source bytes. A host that wants a
    // watermarked original ships a separate jpeg preset.
    outputBuffer = sourceBuffer;
    const meta = await sharp(sourceBuffer).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } else {
    // Apply the active edit recipe, then resize+encode.
    const currentVersion = photo.currentEditVersion ?? 0;
    const currentEdit =
      currentVersion > 0
        ? (photo.editHistory ?? []).find((e) => e.version === currentVersion)
        : undefined;
    const edited = currentEdit
      ? await applyEdits(sourceBuffer, currentEdit.operations)
      : sourceBuffer;

    const out = await sharp(edited)
      .rotate() // honor EXIF orientation
      .resize({
        width: preset.maxEdge,
        height: preset.maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: preset.quality,
        progressive: true,
        mozjpeg: true,
      })
      .toBuffer({ resolveWithObject: true });
    outputBuffer = out.data;
    width = out.info.width;
    height = out.info.height;

    // Composite the watermark on top of the encoded JPEG. We re-encode
    // at the preset quality so the watermark layer doesn't degrade the
    // image any more than the original encode pass.
    if (watermarkActive && preset.watermark) {
      const tenantName = await resolveTenantName(
        data,
        photo.tenantId ?? null
      );
      const watermarked = await renderWatermark({
        inputBuffer: outputBuffer,
        watermark: preset.watermark,
        tokens: {
          tenantName,
          photoId: photo.id,
        },
        jpegQuality: preset.quality,
      });
      outputBuffer = watermarked;
      // Dimensions are preserved by the composite; re-probe in case
      // Sharp normalized orientation differently on the second pass.
      const wmMeta = await sharp(outputBuffer).metadata();
      width = wmMeta.width ?? width;
      height = wmMeta.height ?? height;
    }
  }

  // 3. Write to cache (best-effort; failures here must not block the export).
  await tryWriteCache(storage, cachePath, outputBuffer);

  return {
    buffer: outputBuffer,
    outputBytes: outputBuffer.length,
    outputWidth: width,
    outputHeight: height,
    cacheHit: false,
    cacheKey,
    watermarkApplied: watermarkActive,
  };
}

/**
 * Resolve the tenant's display name (branding `appName`) for `{tenantName}`
 * watermark substitution. Falls back to the tenantId, then the empty
 * string, so a missing branding doc never throws.
 */
async function resolveTenantName(
  data: DataAdapter | undefined,
  tenantId: string | null
): Promise<string> {
  if (!data || !tenantId) return tenantId ?? '';
  try {
    const branding = await data.fetchData<BrandingDoc>(
      BRANDING_COLLECTION,
      tenantId
    );
    return branding?.appName ?? tenantId;
  } catch {
    return tenantId;
  }
}

async function tryReadCache(
  storage: StorageAdapter,
  cachePath: string
): Promise<Buffer | null> {
  try {
    return await storage.readFile(cachePath);
  } catch {
    return null;
  }
}

async function tryWriteCache(
  storage: StorageAdapter,
  cachePath: string,
  buffer: Buffer
): Promise<void> {
  try {
    await storage.storeFile(cachePath, buffer, {
      contentType: 'image/jpeg',
    });
  } catch {
    // best-effort; rendering already succeeded so we still serve the
    // bytes to the caller and just take the next request as a cache
    // miss.
  }
}

// ---------------------------------------------------------------------------
// Signed-URL token (reuses the existing HMAC primitives).
// ---------------------------------------------------------------------------

interface ExportTokenPayload {
  /** photoId */
  p: string;
  /** libraryId */
  l: string;
  /** tenantId */
  t: string;
  /** preset name */
  n: string;
  /** recipeHash */
  r: string;
  /** expiresAt (unix seconds) */
  e: number;
}

/**
 * Default lifetime for export download URLs. Short by design — these
 * URLs hand out billable bandwidth, so the host can refresh them on
 * demand.
 */
export const DEFAULT_EXPORT_URL_TTL_SECONDS = 300; // 5 minutes

/**
 * Build a short-lived signed token for an export download URL. The token
 * is base64url-encoded `<payloadJson>.<signature>` so the GET handler
 * can re-verify it without any database lookup.
 */
export function signExportToken(opts: {
  photoId: string;
  libraryId: string;
  tenantId: string;
  presetName: string;
  recipeHash: string;
  ttlSeconds?: number;
  now?: () => Date;
}): { token: string; expiresAt: number } {
  const ttl = opts.ttlSeconds ?? DEFAULT_EXPORT_URL_TTL_SECONDS;
  const expiresAt =
    Math.floor((opts.now ?? (() => new Date()))().getTime() / 1000) + ttl;
  const payload: ExportTokenPayload = {
    p: opts.photoId,
    l: opts.libraryId,
    t: opts.tenantId,
    n: opts.presetName,
    r: opts.recipeHash,
    e: expiresAt,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
  const sig = signData(deriveExportKey(), `${payloadB64}`);
  const sigB64 = Buffer.from(sig, 'base64').toString('base64url');
  return { token: `${payloadB64}.${sigB64}`, expiresAt };
}

/**
 * Verify an export token and return the decoded payload. Returns null
 * on any failure (malformed, signature mismatch, expired). Verification
 * is constant-time at the signature compare layer.
 */
export function verifyExportToken(
  token: string,
  now: number = Math.floor(Date.now() / 1000)
): ExportTokenPayload | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let payloadJson: string;
  try {
    payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let payload: ExportTokenPayload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (
    typeof payload?.p !== 'string' ||
    typeof payload.l !== 'string' ||
    typeof payload.t !== 'string' ||
    typeof payload.n !== 'string' ||
    typeof payload.r !== 'string' ||
    typeof payload.e !== 'number'
  ) {
    return null;
  }
  if (payload.e <= now) return null;
  // Re-base64-encode the standard signature so verifySignature gets the
  // bytes it expects (it works in plain base64, not base64url).
  let standardSig: string;
  try {
    standardSig = Buffer.from(sigB64, 'base64url').toString('base64');
  } catch {
    return null;
  }
  const ok = verifySignature(deriveExportKey(), payloadB64, standardSig);
  if (!ok) return null;
  return payload;
}

/**
 * Derive the HMAC key used for export-URL tokens from the master signing
 * secret. Distinct from the per-user signing keys so an export URL
 * cannot accidentally be used to mint user signing keys.
 */
function deriveExportKey(): string {
  // The master secret is hex-encoded; reuse the same HMAC primitive as
  // `deriveKey` but with a fixed domain-separator seed.
  const hmac = createHmac(
    'sha256',
    Buffer.from(signingConfig.masterSecret, 'hex')
  );
  hmac.update('aurapix.export-url.v1');
  return hmac.digest('base64');
}
