import sharp from 'sharp';
import type { EditOperation } from '../../models/Photo.js';
import { logger } from '../../utils/logger.js';

/**
 * Apply a sequence of edit operations to an image buffer
 */
export async function applyEdits(
  inputBuffer: Buffer,
  operations: EditOperation[]
): Promise<Buffer> {
  let pipeline = sharp(inputBuffer);

  // Sort operations by order
  const sortedOps = [...operations].sort((a, b) => a.order - b.order);

  logger.debug(
    { operationCount: sortedOps.length },
    'Applying edit operations'
  );

  for (const op of sortedOps) {
    pipeline = await applyOperation(pipeline, op);
  }

  return await pipeline.toBuffer();
}

/**
 * Apply a single edit operation to a Sharp pipeline
 */
async function applyOperation(
  pipeline: sharp.Sharp,
  operation: EditOperation
): Promise<sharp.Sharp> {
  switch (operation.type) {
    case 'crop':
      return applyCrop(pipeline, operation.params);
    
    case 'rotate':
      return applyRotate(pipeline, operation.params);
    
    case 'adjust':
      return applyAdjust(pipeline, operation.params);
    
    case 'filter':
      return applyFilter(pipeline, operation.params);
    
    default:
      logger.warn({ operation }, 'Unknown operation type, skipping');
      return pipeline;
  }
}

/**
 * Crop operation
 * Params: { x: number, y: number, width: number, height: number }
 */
function applyCrop(
  pipeline: sharp.Sharp,
  params: Record<string, any>
): sharp.Sharp {
  const { x, y, width, height } = params;
  
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    logger.warn({ params }, 'Invalid crop parameters');
    return pipeline;
  }

  logger.debug({ x, y, width, height }, 'Applying crop');
  
  return pipeline.extract({
    left: Math.round(x),
    top: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
}

/**
 * Rotate operation
 * Params: { degrees: 90 | 180 | 270 | -90 | -180 | -270 }
 */
function applyRotate(
  pipeline: sharp.Sharp,
  params: Record<string, any>
): sharp.Sharp {
  const { degrees } = params;
  
  if (typeof degrees !== 'number') {
    logger.warn({ params }, 'Invalid rotate parameters');
    return pipeline;
  }

  // Normalize to 0, 90, 180, 270
  const normalized = ((degrees % 360) + 360) % 360;
  
  logger.debug({ degrees: normalized }, 'Applying rotation');
  
  return pipeline.rotate(normalized);
}

/**
 * Adjust operation
 * Params: { brightness?: number, contrast?: number, saturation?: number }
 * Values are multipliers: 1.0 = no change, <1.0 = decrease, >1.0 = increase
 */
function applyAdjust(
  pipeline: sharp.Sharp,
  params: Record<string, any>
): sharp.Sharp {
  const { brightness, contrast, saturation } = params;

  logger.debug({ brightness, contrast, saturation }, 'Applying adjustments');

  // Apply modulate for brightness and saturation
  if (brightness !== undefined || saturation !== undefined) {
    pipeline = pipeline.modulate({
      brightness: typeof brightness === 'number' ? brightness : undefined,
      saturation: typeof saturation === 'number' ? saturation : undefined,
    });
  }

  // Apply linear for contrast
  // Sharp's linear uses: output = (input * a) + b
  // For contrast: a = contrast, b = 128 * (1 - contrast)
  if (typeof contrast === 'number' && contrast !== 1.0) {
    const a = contrast;
    const b = 128 * (1 - contrast);
    pipeline = pipeline.linear(a, b);
  }

  return pipeline;
}

/**
 * Filter operation (plugin-based)
 * Params: { filterName: string, ...filterParams }
 */
function applyFilter(
  pipeline: sharp.Sharp,
  params: Record<string, any>
): sharp.Sharp {
  const { filterName } = params;

  logger.debug({ filterName }, 'Applying filter');

  switch (filterName) {
    case 'grayscale':
      return pipeline.grayscale();
    
    case 'sepia':
      // Sepia tone using recomb matrix
      return pipeline.recomb([
        [0.393, 0.769, 0.189],
        [0.349, 0.686, 0.168],
        [0.272, 0.534, 0.131],
      ]);
    
    case 'blur':
      const sigma = typeof params.sigma === 'number' ? params.sigma : 3;
      return pipeline.blur(sigma);
    
    case 'sharpen':
      const sharpenSigma = typeof params.sigma === 'number' ? params.sigma : 1;
      return pipeline.sharpen({ sigma: sharpenSigma });
    
    case 'negate':
      return pipeline.negate();
    
    default:
      logger.warn({ filterName }, 'Unknown filter, skipping');
      return pipeline;
  }
}

/**
 * Validate edit operations before applying
 */
export function validateOperations(operations: EditOperation[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  for (const op of operations) {
    if (!op.type || !['crop', 'rotate', 'adjust', 'filter'].includes(op.type)) {
      errors.push(`Invalid operation type: ${op.type}`);
    }

    if (typeof op.order !== 'number' || op.order < 0) {
      errors.push(`Invalid order for operation: ${op.type}`);
    }

    if (!op.params || typeof op.params !== 'object') {
      errors.push(`Missing or invalid params for operation: ${op.type}`);
    }

    // Type-specific validation
    switch (op.type) {
      case 'crop':
        const { x, y, width, height } = op.params;
        if (
          typeof x !== 'number' ||
          typeof y !== 'number' ||
          typeof width !== 'number' ||
          typeof height !== 'number' ||
          width <= 0 ||
          height <= 0
        ) {
          errors.push('Crop requires valid x, y, width, height parameters');
        }
        break;

      case 'rotate':
        const { degrees } = op.params;
        if (typeof degrees !== 'number') {
          errors.push('Rotate requires valid degrees parameter');
        }
        break;

      case 'adjust':
        const { brightness, contrast, saturation } = op.params;
        if (
          brightness !== undefined && typeof brightness !== 'number' ||
          contrast !== undefined && typeof contrast !== 'number' ||
          saturation !== undefined && typeof saturation !== 'number'
        ) {
          errors.push('Adjust requires numeric brightness, contrast, or saturation');
        }
        break;

      case 'filter':
        if (!op.params.filterName || typeof op.params.filterName !== 'string') {
          errors.push('Filter requires filterName parameter');
        }
        break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}