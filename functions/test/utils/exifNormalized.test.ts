import { describe, expect, it } from 'vitest';
import { buildNormalizedExif } from '../../src/utils/exif.js';

describe('buildNormalizedExif', () => {
  it('returns undefined when there is nothing useful to persist', () => {
    expect(buildNormalizedExif(null)).toBeUndefined();
    expect(buildNormalizedExif(undefined, { widthPx: 0, heightPx: 0 })).toBeUndefined();
  });

  it('summarises capture date, camera, lens, dimensions and orientation', () => {
    const result = buildNormalizedExif(
      {
        takenAt: '2024-03-14T09:26:53.000Z',
        cameraMake: 'Sony',
        cameraModel: 'ILCE-7M4',
        lensMake: 'Sony',
        lensModel: 'FE 24-70mm F2.8 GM',
        iso: 400,
        fNumber: 2.8,
        exposureTime: 0.008,
        focalLength: 50,
        orientation: 1,
      },
      { widthPx: 7008, heightPx: 4672 }
    );

    expect(result).toEqual({
      capturedAt: '2024-03-14T09:26:53.000Z',
      camera: 'Sony ILCE-7M4',
      lens: 'Sony FE 24-70mm F2.8 GM',
      iso: 400,
      fNumber: 2.8,
      exposureTimeSec: 0.008,
      focalLengthMm: 50,
      widthPx: 7008,
      heightPx: 4672,
      orientation: 1,
    });
  });

  it('avoids duplicating Make when Model already contains it', () => {
    const result = buildNormalizedExif({
      cameraMake: 'Canon',
      cameraModel: 'Canon EOS R5',
    });
    expect(result?.camera).toBe('Canon EOS R5');
  });

  it('omits dimension keys when not provided', () => {
    const result = buildNormalizedExif({ iso: 100 });
    expect(result).toEqual({ iso: 100 });
  });
});
