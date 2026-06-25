/**
 * Shared watermark rendering utility (issue #185).
 *
 * Composites a single-line text watermark over a JPEG buffer, anchored
 * to one of the four image corners. Used by:
 *   - the export pipeline (`exportService.ts`) when an export preset
 *     declares `watermark.enabled: true`
 *   - share delivery (when wired up; today the share service only
 *     records a `watermarkApplied` flag without producing rendered
 *     bytes)
 *
 * Co-locating the renderer here is the "shared util" called for in the
 * issue, so future watermark consumers can `import { renderWatermark }`
 * rather than duplicate SVG/Sharp wiring.
 *
 * Design notes:
 *   - The watermark is drawn as an SVG layer and composited with Sharp,
 *     so the rendering does NOT require a system font \u2014 SVG `<text>`
 *     elements fall back to the default sans-serif glyph metrics in
 *     librsvg, which Sharp ships with.
 *   - Watermark size scales with the rendered image's shortest edge so
 *     a 1280px preset and an 8192px preset produce visually comparable
 *     watermarks.
 *   - All untrusted text is XML-escaped before substitution to prevent
 *     SVG injection from a host-supplied watermark template.
 */
import sharp from 'sharp';
import type { ExportPresetWatermark } from '../../models/ExportPreset.js';

/**
 * Tokens substituted into the watermark text. Intentionally limited to
 * non-PII fields per issue #185 ("no user PII tokens").
 */
export interface WatermarkTokens {
  /** Tenant display name (typically branding `appName`). */
  tenantName?: string;
  /** Photo id. */
  photoId?: string;
  /**
   * Optional `YYYY-MM-DD` date. When omitted, `renderWatermark` fills in
   * today's UTC date so `{date}` always produces a value.
   */
  date?: string;
}

/** Allow `{tenantName}`, `{photoId}`, `{date}` only. */
const TOKEN_PATTERN = /\{(tenantName|photoId|date)\}/g;

/**
 * Substitute the allow-listed tokens in `template`. Unknown `{foo}`
 * sequences are left intact so a host can include literal curly braces
 * in their watermark text without escaping.
 *
 * Exported for unit tests.
 */
export function substituteWatermarkTokens(
  template: string,
  tokens: WatermarkTokens
): string {
  const date = tokens.date ?? isoDateUtc(new Date());
  return template.replace(TOKEN_PATTERN, (_match, key: string) => {
    switch (key) {
      case 'tenantName':
        return tokens.tenantName ?? '';
      case 'photoId':
        return tokens.photoId ?? '';
      case 'date':
        return date;
      default:
        return _match;
    }
  });
}

/**
 * Format a `Date` as `YYYY-MM-DD` in UTC. We don't pull in a date library
 * for this; the slice avoids locale formatting.
 */
function isoDateUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * XML-escape user-supplied text so it can be safely interpolated into
 * an SVG `<text>` body. Covers the five XML entities; everything else
 * (including curly braces) is allowed through.
 */
export function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the SVG overlay used by `renderWatermark`. Exported so tests
 * can assert on the generated markup without exercising Sharp.
 */
export function buildWatermarkSvg(opts: {
  imageWidth: number;
  imageHeight: number;
  text: string;
  opacity: number;
  position: ExportPresetWatermark['position'];
}): string {
  const { imageWidth, imageHeight, text, opacity, position } = opts;

  // Font size scales with the shortest edge so a small thumbnail and a
  // huge full-resolution export both end up with a readable watermark.
  // Clamp to a sensible range so 32px previews don't get an unreadable
  // 4px font and 8192px exports don't get an 80px font that dominates.
  const shortestEdge = Math.max(1, Math.min(imageWidth, imageHeight));
  const fontSize = Math.max(10, Math.min(48, Math.round(shortestEdge * 0.04)));
  const padding = Math.max(6, Math.round(fontSize * 0.6));

  // Anchor + baseline depend on which corner we're targeting. Sharp
  // composites the SVG at (0,0) over the image and inherits the
  // image's dimensions, so we position the text within the SVG itself
  // rather than via composite offsets \u2014 simpler and avoids a separate
  // Sharp call to measure text bounds.
  let x: number;
  let y: number;
  let textAnchor: 'start' | 'end';
  switch (position) {
    case 'top-left':
      x = padding;
      y = padding + fontSize;
      textAnchor = 'start';
      break;
    case 'top-right':
      x = imageWidth - padding;
      y = padding + fontSize;
      textAnchor = 'end';
      break;
    case 'bottom-left':
      x = padding;
      y = imageHeight - padding;
      textAnchor = 'start';
      break;
    case 'bottom-right':
    default:
      x = imageWidth - padding;
      y = imageHeight - padding;
      textAnchor = 'end';
      break;
  }

  // White text with a subtle black stroke so it stays legible on both
  // bright and dark images. `opacity` controls the layer opacity rather
  // than per-fill opacity so the stroke contrast is preserved.
  const safeText = escapeSvgText(text);
  const layerOpacity = clampOpacity(opacity);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}" viewBox="0 0 ${imageWidth} ${imageHeight}">` +
    `<g opacity="${layerOpacity}">` +
    `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" font-weight="600" fill="#ffffff" stroke="#000000" stroke-width="${Math.max(1, Math.round(fontSize * 0.06))}" paint-order="stroke" text-anchor="${textAnchor}">${safeText}</text>` +
    `</g>` +
    `</svg>`
  );
}

/**
 * Clamp the opacity into `[0, 1]`. The validation layer rejects values
 * outside the range, but we double-guard here so a buggy caller cannot
 * produce a malformed SVG attribute.
 */
function clampOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return 1;
  if (opacity < 0) return 0;
  if (opacity > 1) return 1;
  return opacity;
}

/**
 * Render `inputBuffer` with the watermark composited over it. The
 * caller is responsible for ensuring the input is a renderable JPEG
 * (Sharp will reject other formats). The returned buffer is a
 * re-encoded JPEG with the same quality as the input pipeline expects.
 *
 * No-ops (returns the input unchanged) when `watermark.enabled` is
 * false or `watermark.text` (after substitution) is empty.
 */
export async function renderWatermark(opts: {
  inputBuffer: Buffer;
  watermark: ExportPresetWatermark;
  tokens?: WatermarkTokens;
  /** JPEG quality to re-encode at. Defaults to 90. */
  jpegQuality?: number;
}): Promise<Buffer> {
  const { inputBuffer, watermark, tokens, jpegQuality = 90 } = opts;
  if (!watermark.enabled) return inputBuffer;
  const finalText = substituteWatermarkTokens(watermark.text, tokens ?? {});
  if (!finalText.trim()) return inputBuffer;

  const pipeline = sharp(inputBuffer);
  const meta = await pipeline.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) {
    // Cannot place a watermark without dimensions; fail open with the
    // unwatermarked bytes rather than throwing \u2014 export pipelines that
    // already wrote a cache entry can still serve the source.
    return inputBuffer;
  }

  const svg = buildWatermarkSvg({
    imageWidth: width,
    imageHeight: height,
    text: finalText,
    opacity: watermark.opacity,
    position: watermark.position,
  });

  return pipeline
    .composite([{ input: Buffer.from(svg, 'utf8'), top: 0, left: 0 }])
    .jpeg({ quality: jpegQuality, progressive: true, mozjpeg: true })
    .toBuffer();
}
