import { describe, expect, it } from 'vitest';
import { isSupportedUploadFile } from './supportedUploadFiles';

describe('isSupportedUploadFile', () => {
  it('accepts regular image mime types', () => {
    expect(isSupportedUploadFile({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(true);
  });

  it('accepts known raw file extensions even with generic mime type', () => {
    expect(isSupportedUploadFile({ name: 'capture.CR3', type: 'application/octet-stream' })).toBe(
      true
    );
    expect(isSupportedUploadFile({ name: 'frame.nef', type: '' })).toBe(true);
  });

  it('rejects unsupported file types', () => {
    expect(isSupportedUploadFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
    expect(isSupportedUploadFile({ name: 'archive.zip', type: 'application/zip' })).toBe(false);
  });
});
