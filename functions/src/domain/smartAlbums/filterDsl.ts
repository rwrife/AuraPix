/**
 * Filter DSL validator for Smart Albums (issue #165).
 *
 * Keep this list closed. Adding a new key requires bumping the contract
 * and updating `parseSmartAlbumFilter`. Unknown keys are rejected outright
 * so a host cannot smuggle arbitrary fields into our Firestore query
 * builder.
 */
import { z } from 'zod';
import type { SmartAlbumFilter } from './types.js';

const RATING_SCHEMA = z
  .object({
    gte: z.number().int().min(0).max(5).optional(),
    lte: z.number().int().min(0).max(5).optional(),
  })
  .strict()
  .refine(
    (r) => r.gte === undefined || r.lte === undefined || r.gte <= r.lte,
    { message: 'rating.gte must be <= rating.lte' }
  );

const FLAG_SCHEMA = z.enum(['pick', 'reject']);

const TAGS_SCHEMA = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(50);

const MIME_TYPES_SCHEMA = z
  .array(z.string().trim().min(1).max(120))
  .min(1)
  .max(50);

const CAPTURED_BETWEEN_SCHEMA = z
  .tuple([
    z.string().datetime({ offset: true }),
    z.string().datetime({ offset: true }),
  ])
  .refine(([from, to]) => Date.parse(from) <= Date.parse(to), {
    message: 'capturedBetween[0] must be <= capturedBetween[1]',
  });

export const SMART_ALBUM_FILTER_SCHEMA = z
  .object({
    rating: RATING_SCHEMA.optional(),
    flag: FLAG_SCHEMA.optional(),
    tags: TAGS_SCHEMA.optional(),
    capturedBetween: CAPTURED_BETWEEN_SCHEMA.optional(),
    mimeTypes: MIME_TYPES_SCHEMA.optional(),
  })
  .strict();

export const SMART_ALBUM_NAME_SCHEMA = z.string().trim().min(1).max(120);

export class SmartAlbumValidationError extends Error {
  public readonly status = 400;
  public readonly code = 'smart-album-invalid-filter';
  constructor(message: string, public readonly issues: unknown) {
    super(message);
    this.name = 'SmartAlbumValidationError';
  }
}

/**
 * Validate and normalize a filter DSL value. Returns a frozen filter
 * suitable for storage. Throws {@link SmartAlbumValidationError} on
 * invalid input (including unknown keys).
 */
export function parseSmartAlbumFilter(input: unknown): SmartAlbumFilter {
  const result = SMART_ALBUM_FILTER_SCHEMA.safeParse(input);
  if (!result.success) {
    throw new SmartAlbumValidationError(
      'Smart album filter is invalid',
      result.error.issues
    );
  }
  // Normalize: strip empty `rating: {}` so callers see consistent shapes.
  const out: SmartAlbumFilter = { ...result.data };
  if (out.rating && out.rating.gte === undefined && out.rating.lte === undefined) {
    delete out.rating;
  }
  return out;
}

/**
 * Validate a smart-album name; trims and rejects empty/over-long values.
 */
export function parseSmartAlbumName(input: unknown): string {
  const result = SMART_ALBUM_NAME_SCHEMA.safeParse(input);
  if (!result.success) {
    throw new SmartAlbumValidationError(
      'Smart album name is required (1-120 chars)',
      result.error.issues
    );
  }
  return result.data;
}
