/**
 * Tag normalization rules for photo keywords (issue #173).
 *
 * Tags are freeform Lightroom-style keywords. To keep the vocabulary
 * predictable we:
 *
 *  - Trim leading/trailing whitespace.
 *  - Lowercase (so `Wedding` and `wedding` collapse to one tag).
 *  - Collapse internal whitespace runs to a single space.
 *  - Reject empties and tags longer than {@link MAX_TAG_LENGTH}.
 *  - Cap the per-photo total at {@link MAX_TAGS_PER_PHOTO}.
 *
 * Normalization is intentionally idempotent and lossless after the first
 * call, so the same input always yields the same canonical form whether it
 * comes from the API, a future bulk-tag job, or a sidecar import.
 */

export const MAX_TAG_LENGTH = 64;
export const MAX_TAGS_PER_PHOTO = 50;

export class TagValidationError extends Error {
  public readonly status = 400;
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TagValidationError';
    this.code = code;
  }
}

/**
 * Normalize a single tag value. Returns null when the value is null,
 * undefined, or empty after trimming — callers decide whether to treat
 * that as a no-op or an error.
 */
export function normalizeTag(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') {
    throw new TagValidationError(
      'tag-invalid-type',
      'Tags must be strings'
    );
  }
  const collapsed = input.trim().replace(/\s+/g, ' ').toLowerCase();
  if (collapsed.length === 0) return null;
  if (collapsed.length > MAX_TAG_LENGTH) {
    throw new TagValidationError(
      'tag-too-long',
      `Tags must be ${MAX_TAG_LENGTH} characters or fewer`
    );
  }
  return collapsed;
}

/**
 * Normalize a list of tags: drops empties/null, de-duplicates while
 * preserving first-seen order, and throws if any value violates the
 * per-tag rules.
 */
export function normalizeTagList(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new TagValidationError(
      'tags-not-array',
      'Tags must be an array of strings'
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Apply an add/remove mutation against an existing tag list. Returns the
 * final list (already normalized, de-duplicated, capped) plus the
 * cardinality of effective add/remove operations so metering can report
 * how much organizational work the caller did.
 */
export interface TagMutationResult {
  /** Final, normalized, capped list (length ≤ {@link MAX_TAGS_PER_PHOTO}). */
  next: string[];
  /** Number of tags that were actually added (not previously present). */
  added: number;
  /** Number of tags that were actually removed (had been present). */
  removed: number;
  /** True when {@link next} differs from the input `current`. */
  changed: boolean;
}

export function applyTagMutation(
  current: string[] | undefined | null,
  mutation: { add?: unknown; remove?: unknown }
): TagMutationResult {
  const start = normalizeTagList(current ?? []);
  const startSet = new Set(start);

  const addList = normalizeTagList(mutation.add);
  const removeList = normalizeTagList(mutation.remove);

  const removeSet = new Set(removeList);
  // Remove first so add can re-introduce if the caller passed both.
  const afterRemove = start.filter((t) => !removeSet.has(t));
  const afterRemoveSet = new Set(afterRemove);

  let added = 0;
  for (const t of addList) {
    if (afterRemoveSet.has(t)) continue;
    afterRemoveSet.add(t);
    afterRemove.push(t);
    added += 1;
  }

  if (afterRemove.length > MAX_TAGS_PER_PHOTO) {
    throw new TagValidationError(
      'too-many-tags',
      `A photo may have at most ${MAX_TAGS_PER_PHOTO} tags`
    );
  }

  let removed = 0;
  for (const t of removeList) {
    if (startSet.has(t)) removed += 1;
  }

  const changed =
    afterRemove.length !== start.length ||
    afterRemove.some((t, i) => t !== start[i]);

  return { next: afterRemove, added, removed, changed };
}

/**
 * Parse a comma-separated tag filter (e.g. the `tags` query string).
 * Empty / missing input returns an empty array. Per the issue, filter
 * semantics are AND across the returned values; this helper only handles
 * parsing.
 */
export function parseTagsQuery(input: unknown): string[] {
  if (input === undefined || input === null || input === '') return [];
  const raw = Array.isArray(input)
    ? input.flatMap((v) => String(v).split(','))
    : String(input).split(',');
  return normalizeTagList(raw);
}
