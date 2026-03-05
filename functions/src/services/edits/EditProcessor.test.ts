import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { applyEdits, validateOperations } from './EditProcessor.js';

describe('EditProcessor adjust exposure', () => {
  it('accepts numeric exposure values in validation', () => {
    const result = validateOperations([
      {
        type: 'adjust',
        order: 0,
        params: { exposure: 1 },
      },
    ]);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects non-numeric exposure values in validation', () => {
    const result = validateOperations([
      {
        type: 'adjust',
        order: 0,
        params: { exposure: 'high' },
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('exposure');
  });

  it('applies exposure in stops (+EV brighter, -EV darker)', async () => {
    const base = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 100, g: 100, b: 100 },
      },
    })
      .png()
      .toBuffer();

    const brighter = await applyEdits(base, [
      {
        type: 'adjust',
        order: 0,
        params: { exposure: 1 },
      },
    ]);

    const darker = await applyEdits(base, [
      {
        type: 'adjust',
        order: 0,
        params: { exposure: -1 },
      },
    ]);

    const [baseStats, brightStats, darkStats] = await Promise.all([
      sharp(base).stats(),
      sharp(brighter).stats(),
      sharp(darker).stats(),
    ]);

    expect(brightStats.channels[0]?.mean ?? 0).toBeGreaterThan(baseStats.channels[0]?.mean ?? 0);
    expect(darkStats.channels[0]?.mean ?? 0).toBeLessThan(baseStats.channels[0]?.mean ?? 0);
  });
});
