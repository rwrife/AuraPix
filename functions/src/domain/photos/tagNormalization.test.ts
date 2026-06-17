import { describe, it, expect } from 'vitest';
import {
  normalizeTag,
  normalizeTagList,
  applyTagMutation,
  parseTagsQuery,
  TagValidationError,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_PHOTO,
} from './tagNormalization.js';

describe('normalizeTag', () => {
  it('lowercases and trims', () => {
    expect(normalizeTag('  Wedding  ')).toBe('wedding');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeTag('Print   Ready')).toBe('print ready');
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
  });

  it('returns null for null / undefined', () => {
    expect(normalizeTag(null)).toBeNull();
    expect(normalizeTag(undefined)).toBeNull();
  });

  it('throws for non-string input', () => {
    expect(() => normalizeTag(42)).toThrowError(TagValidationError);
    expect(() => normalizeTag({ tag: 'x' })).toThrowError(TagValidationError);
  });

  it('throws when over the per-tag length cap', () => {
    const tooLong = 'x'.repeat(MAX_TAG_LENGTH + 1);
    expect(() => normalizeTag(tooLong)).toThrowError(/64 characters/);
  });

  it('allows exactly the maximum length', () => {
    const exact = 'x'.repeat(MAX_TAG_LENGTH);
    expect(normalizeTag(exact)).toBe(exact);
  });
});

describe('normalizeTagList', () => {
  it('drops empties and de-duplicates while preserving order', () => {
    expect(normalizeTagList(['Wedding', 'wedding', '', '  ', 'Client:Smith']))
      .toEqual(['wedding', 'client:smith']);
  });

  it('returns [] for null / undefined', () => {
    expect(normalizeTagList(null)).toEqual([]);
    expect(normalizeTagList(undefined)).toEqual([]);
  });

  it('throws for non-array input', () => {
    expect(() => normalizeTagList('wedding,client')).toThrowError(
      TagValidationError
    );
  });
});

describe('applyTagMutation', () => {
  it('adds new tags idempotently (re-adding is a no-op)', () => {
    const result = applyTagMutation(['wedding'], { add: ['Wedding', 'print-ready'] });
    expect(result.next).toEqual(['wedding', 'print-ready']);
    expect(result.added).toBe(1); // only print-ready was new
    expect(result.removed).toBe(0);
    expect(result.changed).toBe(true);
  });

  it('removes tags idempotently (removing absent is a no-op)', () => {
    const result = applyTagMutation(['wedding', 'print-ready'], {
      remove: ['Print-Ready', 'nonexistent'],
    });
    expect(result.next).toEqual(['wedding']);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
    expect(result.changed).toBe(true);
  });

  it('handles add and remove in one call (remove first, then add)', () => {
    const result = applyTagMutation(['wedding', 'draft'], {
      add: ['print-ready'],
      remove: ['draft'],
    });
    expect(result.next).toEqual(['wedding', 'print-ready']);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.changed).toBe(true);
  });

  it('reports changed=false when add/remove is a no-op', () => {
    const result = applyTagMutation(['wedding'], { add: ['wedding'], remove: ['nope'] });
    expect(result.next).toEqual(['wedding']);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.changed).toBe(false);
  });

  it('handles missing/empty current list', () => {
    expect(applyTagMutation(undefined, { add: ['a'] }).next).toEqual(['a']);
    expect(applyTagMutation(null, { add: ['a'] }).next).toEqual(['a']);
    expect(applyTagMutation([], { add: ['a', 'b'] }).next).toEqual(['a', 'b']);
  });

  it('throws when the result would exceed the per-photo cap', () => {
    const start = Array.from({ length: MAX_TAGS_PER_PHOTO }, (_, i) => `tag-${i}`);
    expect(() =>
      applyTagMutation(start, { add: ['one-more'] })
    ).toThrowError(/at most 50/);
  });

  it('allows exactly MAX_TAGS_PER_PHOTO', () => {
    const start = Array.from({ length: MAX_TAGS_PER_PHOTO - 1 }, (_, i) => `t-${i}`);
    const result = applyTagMutation(start, { add: ['last'] });
    expect(result.next.length).toBe(MAX_TAGS_PER_PHOTO);
  });

  it('rejects malformed tags inside add/remove', () => {
    expect(() => applyTagMutation([], { add: [42] })).toThrowError(
      TagValidationError
    );
  });
});

describe('parseTagsQuery', () => {
  it('parses comma-separated string', () => {
    expect(parseTagsQuery('wedding,print-ready')).toEqual([
      'wedding',
      'print-ready',
    ]);
  });

  it('normalizes and de-duplicates', () => {
    expect(parseTagsQuery('Wedding, Wedding ,print-ready')).toEqual([
      'wedding',
      'print-ready',
    ]);
  });

  it('returns [] for empty / missing input', () => {
    expect(parseTagsQuery('')).toEqual([]);
    expect(parseTagsQuery(undefined)).toEqual([]);
    expect(parseTagsQuery(null)).toEqual([]);
  });

  it('handles array input (e.g. tags=a&tags=b)', () => {
    expect(parseTagsQuery(['a', 'b,c'])).toEqual(['a', 'b', 'c']);
  });
});
