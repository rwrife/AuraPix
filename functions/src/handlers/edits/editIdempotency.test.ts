import { describe, expect, it } from 'vitest';
import {
  createApplyEditsFingerprint,
  createRevertFingerprint,
  editFingerprintMatches,
  getNormalizedIdempotencyKey,
} from './editIdempotency.js';

describe('editIdempotency', () => {
  it('normalizes idempotency key and rejects too-long values', () => {
    expect(getNormalizedIdempotencyKey('  abc-123  ')).toBe('abc-123');
    expect(getNormalizedIdempotencyKey('')).toBeNull();
    expect(getNormalizedIdempotencyKey(undefined)).toBeNull();

    expect(() => getNormalizedIdempotencyKey('x'.repeat(129))).toThrow(
      'Idempotency key exceeds 128 characters.'
    );
  });

  it('matches apply fingerprints only for identical payloads', () => {
    const one = createApplyEditsFingerprint({
      recipeVersion: 1,
      operations: [{ plugin: 'brightness', params: { amount: 10 } }],
      description: 'brighten',
    });

    const same = createApplyEditsFingerprint({
      recipeVersion: 1,
      operations: [{ plugin: 'brightness', params: { amount: 10 } }],
      description: 'brighten',
    });

    const different = createApplyEditsFingerprint({
      recipeVersion: 1,
      operations: [{ plugin: 'brightness', params: { amount: 20 } }],
      description: 'brighten',
    });

    expect(editFingerprintMatches(one, same)).toBe(true);
    expect(editFingerprintMatches(one, different)).toBe(false);
  });

  it('matches revert fingerprints for same target version only', () => {
    const one = createRevertFingerprint(2);
    const same = createRevertFingerprint(2);
    const different = createRevertFingerprint(3);

    expect(editFingerprintMatches(one, same)).toBe(true);
    expect(editFingerprintMatches(one, different)).toBe(false);
  });

  it('never matches apply vs revert fingerprints', () => {
    const apply = createApplyEditsFingerprint({
      recipeVersion: 1,
      operations: [{ plugin: 'contrast', params: { amount: 5 } }],
    });
    const revert = createRevertFingerprint(1);

    expect(editFingerprintMatches(apply, revert)).toBe(false);
  });
});
