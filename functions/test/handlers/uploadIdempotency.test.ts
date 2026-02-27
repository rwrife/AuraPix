import { describe, expect, it } from 'vitest';
import {
  createUploadFingerprint,
  getNormalizedIdempotencyKey,
  uploadFingerprintMatches,
} from '../../src/handlers/images/uploadIdempotency.js';

describe('upload idempotency helpers', () => {
  it('normalizes a valid idempotency key', () => {
    expect(getNormalizedIdempotencyKey('  abc-123  ')).toBe('abc-123');
  });

  it('returns null when idempotency key is empty', () => {
    expect(getNormalizedIdempotencyKey('   ')).toBeNull();
    expect(getNormalizedIdempotencyKey(undefined)).toBeNull();
  });

  it('rejects overly long keys', () => {
    const longKey = 'x'.repeat(129);
    expect(() => getNormalizedIdempotencyKey(longKey)).toThrow('Idempotency key exceeds');
  });

  it('matches identical upload fingerprints', () => {
    const first = createUploadFingerprint({
      originalname: 'photo.jpg',
      mimetype: 'image/jpeg',
      size: 123,
    });

    const second = createUploadFingerprint({
      originalname: 'photo.jpg',
      mimetype: 'image/jpeg',
      size: 123,
    });

    expect(uploadFingerprintMatches(first, second)).toBe(true);
  });

  it('detects mismatched upload fingerprints', () => {
    const first = createUploadFingerprint({
      originalname: 'photo.jpg',
      mimetype: 'image/jpeg',
      size: 123,
    });

    const second = createUploadFingerprint({
      originalname: 'photo-edited.jpg',
      mimetype: 'image/jpeg',
      size: 123,
    });

    expect(uploadFingerprintMatches(first, second)).toBe(false);
  });
});
