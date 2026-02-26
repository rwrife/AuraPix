import sharp from 'sharp';
import { imageConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

export interface ResizeOptions {
  width: number;
  height: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
}

export interface ImageProcessingResult {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
  size: number;
}

/**
 * Resize and optimize image
 */
export async function resizeImage(
  inputBuffer: Buffer,
  options: ResizeOptions,
  format: 'webp' | 'jpeg'
): Promise<ImageProcessingResult> {
  const quality =
    format === 'webp' ? imageConfig.quality.webp : imageConfig.quality.jpeg;

  let pipeline = sharp(inputBuffer).resize({
    width: options.width,
    height: options.height,
    fit: options.fit || 'cover',
    position: 'center',
    withoutEnlargement: true, // Don't upscale images
  });

  // Apply format-specific optimizations
  if (format === 'webp') {
    pipeline = pipeline.webp({ quality, effort: 4 });
  } else {
    pipeline = pipeline.jpeg({ quality, progressive: true, mozjpeg: true });
  }

  const buffer = await pipeline.toBuffer({ resolveWithObject: true });

  return {
    buffer: buffer.data,
    width: buffer.info.width,
    height: buffer.info.height,
    format: buffer.info.format,
    size: buffer.info.size,
  };
}

/**
 * Generate a thumbnail at a specific size
 */
export async function generateThumbnail(
  inputBuffer: Buffer,
  size: number,
  format: 'webp' | 'jpeg'
): Promise<Buffer> {
  const result = await resizeImage(
    inputBuffer,
    {
      width: size,
      height: size,
      fit: 'cover',
    },
    format
  );

  logger.debug(
    {
      size,
      format,
      outputSize: result.size,
      dimensions: `${result.width}x${result.height}`,
    },
    'Generated thumbnail'
  );

  return result.buffer;
}

/**
 * Generate all thumbnail variants (3 sizes × 2 formats = 6 files)
 */
export async function generateAllThumbnails(
  inputBuffer: Buffer
): Promise<{
  small_webp: Buffer;
  small_jpeg: Buffer;
  medium_webp: Buffer;
  medium_jpeg: Buffer;
  large_webp: Buffer;
  large_jpeg: Buffer;
}> {
  const { thumbnailSizes } = imageConfig;

  logger.info('Generating all thumbnail variants');

  // Generate all thumbnails in parallel
  const [
    small_webp,
    small_jpeg,
    medium_webp,
    medium_jpeg,
    large_webp,
    large_jpeg,
  ] = await Promise.all([
    generateThumbnail(inputBuffer, thumbnailSizes.small, 'webp'),
    generateThumbnail(inputBuffer, thumbnailSizes.small, 'jpeg'),
    generateThumbnail(inputBuffer, thumbnailSizes.medium, 'webp'),
    generateThumbnail(inputBuffer, thumbnailSizes.medium, 'jpeg'),
    generateThumbnail(inputBuffer, thumbnailSizes.large, 'webp'),
    generateThumbnail(inputBuffer, thumbnailSizes.large, 'jpeg'),
  ]);

  return {
    small_webp,
    small_jpeg,
    medium_webp,
    medium_jpeg,
    large_webp,
    large_jpeg,
  };
}