import { z } from 'zod';

/**
 * Common validation schemas
 */

export const PhotoIdSchema = z.string().uuid();
export const LibraryIdSchema = z.string().uuid();

export const PhotoSizeSchema = z.enum(['small', 'medium', 'large', 'original']);
export const ImageFormatSchema = z.enum(['webp', 'jpeg']);

export const UploadPhotoSchema = z.object({
  libraryId: LibraryIdSchema,
  file: z.any(), // File from multer
});

export const ServeImageQuerySchema = z.object({
  size: PhotoSizeSchema.optional().default('medium'),
  format: ImageFormatSchema.optional().default('webp'),
});

export const GenerateThumbnailsSchema = z.object({
  libraryId: LibraryIdSchema,
  photoId: PhotoIdSchema,
});

export const ApplyEditsSchema = z.object({
  operations: z.array(
    z.object({
      type: z.enum(['crop', 'rotate', 'adjust', 'filter']),
      params: z.record(z.any()),
      order: z.number().int().min(0),
    })
  ),
  description: z.string().optional(),
});

export const RevertVersionSchema = z.object({
  targetVersion: z.number().int().min(0),
});

/**
 * Validation helper
 */
export function validateRequest<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: string } {
  try {
    const validated = schema.parse(data);
    return { success: true, data: validated };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
      };
    }
    return { success: false, error: 'Validation failed' };
  }
}