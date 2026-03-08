import { describe, expect, it } from 'vitest';
import { fileExtension, isRawUpload } from './rawSupport.js';

describe('rawSupport', () => {
  it('detects RAW by extension', () => {
    expect(isRawUpload('photo.ARW', 'application/octet-stream')).toBe(true);
    expect(isRawUpload('photo.dng', '')).toBe(true);
  });

  it('detects RAW by mime type', () => {
    expect(isRawUpload('photo.bin', 'image/x-sony-arw')).toBe(true);
  });

  it('extracts lowercase extension', () => {
    expect(fileExtension('My.Photo.CR3')).toBe('cr3');
  });
});
