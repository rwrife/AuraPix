import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  buildWatermarkSvg,
  escapeSvgText,
  renderWatermark,
  substituteWatermarkTokens,
} from './index.js';
import type { ExportPresetWatermark } from '../../models/ExportPreset.js';

describe('substituteWatermarkTokens', () => {
  it('replaces {tenantName}, {photoId}, and {date}', () => {
    const result = substituteWatermarkTokens(
      'PROOF — {tenantName} / {photoId} @ {date}',
      { tenantName: 'Acme', photoId: 'p_1', date: '2026-06-24' }
    );
    expect(result).toBe('PROOF — Acme / p_1 @ 2026-06-24');
  });

  it('fills in today’s UTC date when {date} token is unfilled', () => {
    const result = substituteWatermarkTokens('shot on {date}', {});
    // ISO date prefix shape: YYYY-MM-DD
    expect(result).toMatch(/^shot on \d{4}-\d{2}-\d{2}$/);
  });

  it('substitutes missing tenantName / photoId to empty string', () => {
    expect(substituteWatermarkTokens('a-{tenantName}-b-{photoId}-c', {})).toBe(
      'a--b--c'
    );
  });

  it('passes through unknown {foo} tokens verbatim (no user PII tokens)', () => {
    // {email} is not an allowed token; it must be left intact so a host
    // accidentally including it doesn't leak PII *and* doesn't error.
    expect(substituteWatermarkTokens('hi {email}', { tenantName: 'X' })).toBe(
      'hi {email}'
    );
  });
});

describe('escapeSvgText', () => {
  it('escapes the five XML entities and leaves other text alone', () => {
    expect(escapeSvgText(`Tom & Jerry "<3" 'won'`)).toBe(
      'Tom &amp; Jerry &quot;&lt;3&quot; &apos;won&apos;'
    );
    expect(escapeSvgText('plain text 123')).toBe('plain text 123');
  });
});

describe('buildWatermarkSvg', () => {
  it('anchors bottom-right by default with end text-anchor', () => {
    const svg = buildWatermarkSvg({
      imageWidth: 1000,
      imageHeight: 500,
      text: 'hi',
      opacity: 0.5,
      position: 'bottom-right',
    });
    expect(svg).toContain('text-anchor="end"');
    expect(svg).toMatch(/x="(\d+)"/);
    // y should be near imageHeight (less padding)
    expect(svg).toMatch(/y="(4\d\d|500)"/);
    expect(svg).toContain('opacity="0.5"');
  });

  it('anchors top-left with start text-anchor', () => {
    const svg = buildWatermarkSvg({
      imageWidth: 1000,
      imageHeight: 500,
      text: 'hi',
      opacity: 0.7,
      position: 'top-left',
    });
    expect(svg).toContain('text-anchor="start"');
  });

  it('clamps opacity to [0,1] when given out-of-range input', () => {
    const high = buildWatermarkSvg({
      imageWidth: 100,
      imageHeight: 100,
      text: 'x',
      opacity: 5,
      position: 'top-right',
    });
    expect(high).toContain('opacity="1"');
    const low = buildWatermarkSvg({
      imageWidth: 100,
      imageHeight: 100,
      text: 'x',
      opacity: -1,
      position: 'top-right',
    });
    expect(low).toContain('opacity="0"');
  });

  it('XML-escapes the text so the SVG cannot be injection-broken', () => {
    const svg = buildWatermarkSvg({
      imageWidth: 100,
      imageHeight: 100,
      text: '</text><script>alert(1)</script>',
      opacity: 0.5,
      position: 'bottom-right',
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;/text&gt;&lt;script&gt;');
  });
});

describe('renderWatermark', () => {
  async function tinyJpeg(): Promise<Buffer> {
    return sharp({
      create: {
        width: 64,
        height: 48,
        channels: 3,
        background: { r: 50, g: 50, b: 50 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  it('returns the input unchanged when enabled is false', async () => {
    const input = await tinyJpeg();
    const out = await renderWatermark({
      inputBuffer: input,
      watermark: {
        enabled: false,
        text: 'PROOF',
        opacity: 0.5,
        position: 'bottom-right',
      } satisfies ExportPresetWatermark,
    });
    expect(out).toBe(input);
  });

  it('returns the input unchanged when (substituted) text is empty', async () => {
    const input = await tinyJpeg();
    const out = await renderWatermark({
      inputBuffer: input,
      watermark: {
        enabled: true,
        text: '{tenantName}', // tenantName not supplied -> empty
        opacity: 0.5,
        position: 'bottom-right',
      } satisfies ExportPresetWatermark,
    });
    expect(out).toBe(input);
  });

  it('returns watermarked bytes that decode as a JPEG with the same dimensions', async () => {
    const input = await tinyJpeg();
    const out = await renderWatermark({
      inputBuffer: input,
      watermark: {
        enabled: true,
        text: 'PROOF — {tenantName}',
        opacity: 0.5,
        position: 'bottom-right',
      } satisfies ExportPresetWatermark,
      tokens: { tenantName: 'Acme' },
    });
    // Must still be a JPEG
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(48);
    expect(meta.format).toBe('jpeg');
    // Different bytes than the input.
    expect(Buffer.compare(out, input)).not.toBe(0);
  });
});
