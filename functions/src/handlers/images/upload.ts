import type { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import multer from 'multer';
import sharp from 'sharp';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { extractExifData, buildNormalizedExif } from '../../utils/exif.js';
import {
  createUploadFingerprint,
  getNormalizedIdempotencyKey,
  getUploadIdempotencyRecord,
  storeUploadIdempotencyRecord,
  uploadFingerprintMatches,
} from './uploadIdempotency.js';
import { generatePhotoPaths } from '../../config/storage-paths.js';
import { securityConfig } from '../../config/index.js';
import { createPhotoDocument } from '../../models/Photo.js';
import type { PhotoMetadata } from '../../models/Photo.js';
import { evaluateUploadPolicy } from '../../services/host/uploadPolicy.js';
import { fileExtension, isRawUpload } from '../../services/image/rawSupport.js';
import {
  emitMeteringEvent,
  resolveTenantId,
} from '../../services/metering/index.js';
import { readCurrentUsageBytes } from '../../services/metering/currentUsage.js';
import { getTenantRecord } from '../../services/tenant/tenantRecordService.js';
import { evaluateStorageThresholds } from '../../services/tenant/storageThresholdEvaluator.js';
import { wouldExceedQuota } from '../../models/TenantRecord.js';
import type { DailyDocStore } from '../../services/metering/UsageRollupConsumer.js';

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max
  },
  fileFilter: (req, file, cb) => {
    // Accept standard images plus common RAW camera formats.
    if (!file.mimetype.startsWith('image/') && !isRawUpload(file.originalname, file.mimetype)) {
      cb(new AppError(400, 'INVALID_FILE_TYPE', 'Only image/RAW photo files are allowed'));
      return;
    }
    cb(null, true);
  },
});

export const uploadMiddleware = upload.single('file');

/**
 * Extract metadata from image using Sharp and complete EXIF data
 */
async function extractMetadata(
  imageBuffer: Buffer,
  originalName: string,
  mimeType: string
): Promise<PhotoMetadata & { extension: string; exifExtracted: boolean }> {
  let metadata: sharp.Metadata | null = null;

  try {
    metadata = await sharp(imageBuffer).metadata();
  } catch {
    metadata = null;
  }

  // Extract comprehensive EXIF data using exifr. Best-effort: never fail the
  // upload because EXIF parsing went wrong (see issue #151).
  logger.info('Extracting EXIF data from image');
  let exifData: Awaited<ReturnType<typeof extractExifData>> = null;
  try {
    exifData = await extractExifData(imageBuffer);
  } catch (err) {
    logger.warn({ err }, 'EXIF extraction threw; continuing without EXIF');
    exifData = null;
  }
  const exifExtracted = !!exifData;

  // Use EXIF data to populate metadata fields
  // Prefer EXIF data over Sharp metadata when available
  const takenAt = exifData?.takenAt;
  const cameraMake = exifData?.cameraMake;
  const cameraModel = exifData?.cameraModel;

  // Extract GPS location from EXIF if available
  const location =
    exifData?.gps?.latitude && exifData?.gps?.longitude
      ? {
          lat: exifData.gps.latitude,
          lng: exifData.gps.longitude,
        }
      : undefined;

  const extension = metadata?.format || fileExtension(originalName) || 'jpg';

  const looksRaw = isRawUpload(originalName, mimeType);
  const normalizedMimeType = metadata?.format
    ? `image/${metadata.format}`
    : looksRaw
      ? 'application/x-raw-image'
      : mimeType || 'image/jpeg';

  return {
    width: metadata?.width || 0,
    height: metadata?.height || 0,
    mimeType: normalizedMimeType,
    sizeBytes: imageBuffer.length,
    takenAt,
    location,
    cameraMake,
    cameraModel,
    exif: exifData || undefined, // Store complete EXIF data
    extension,
    exifExtracted,
  };
}

/**
 * Handle photo upload
 * POST /images/:libraryId
 */
export async function handleUpload(
  req: Request,
  res: Response
): Promise<void> {
  const storageAdapter = req.app.locals.storageAdapter as StorageAdapter;
  const dataAdapter = req.app.locals.dataAdapter as DataAdapter;

  const libraryId = req.params.libraryId as string;
  const file = req.file;

  if (!file) {
    throw new AppError(400, 'NO_FILE', 'No file provided');
  }

  if (!libraryId) {
    throw new AppError(400, 'NO_LIBRARY_ID', 'Library ID is required');
  }

  // TODO: Verify user has access to this library
  const userId = req.user?.uid || 'anonymous';

  const policyDecision = await evaluateUploadPolicy(
    {
      userId,
      libraryId,
      sizeBytes: file.size,
      mimeType: file.mimetype,
      originalName: file.originalname,
    },
    {
      webhookUrl: securityConfig.hostPolicy.uploadWebhookUrl,
      timeoutMs: securityConfig.hostPolicy.timeoutMs,
    }
  );

  if (!policyDecision.allow) {
    throw new AppError(
      403,
      'UPLOAD_BLOCKED_BY_HOST_POLICY',
      policyDecision.reason || 'Upload denied by host integration policy'
    );
  }

  // Defense-in-depth: enforce the tenant's storage quota in-process, even
  // when the host policy webhook is misconfigured / down. See issue #139.
  const tenantId = resolveTenantId({
    tenantId: req.tenantId,
    libraryId,
  });
  const tenantRecord = await getTenantRecord(dataAdapter, tenantId);
  const usageDailyStore = req.app.locals.usageDailyStore as
    | DailyDocStore
    | undefined;
  if (usageDailyStore && tenantRecord.quotaBytes !== null) {
    const currentUsageBytes = await readCurrentUsageBytes(
      usageDailyStore,
      tenantId
    );
    if (
      wouldExceedQuota(currentUsageBytes, file.size, tenantRecord.quotaBytes)
    ) {
      emitMeteringEvent({
        tenantId,
        type: 'quota.exceeded',
        count: 1,
        bytes: file.size,
        resourceId: userId,
        meta: {
          libraryId,
          usageBytes: currentUsageBytes,
          quotaBytes: tenantRecord.quotaBytes,
          attemptedBytes: file.size,
        },
      });
      logger.warn(
        {
          tenantId,
          libraryId,
          usageBytes: currentUsageBytes,
          quotaBytes: tenantRecord.quotaBytes,
          attemptedBytes: file.size,
        },
        'Upload rejected: tenant storage quota exceeded'
      );
      throw new AppError(
        413,
        'quota_exceeded',
        'Upload would exceed tenant storage quota',
        {
          usageBytes: currentUsageBytes,
          quotaBytes: tenantRecord.quotaBytes,
          attemptedBytes: file.size,
        }
      );
    }
  }

  let idempotencyKey: string | null;
  try {
    idempotencyKey = getNormalizedIdempotencyKey(req.header('Idempotency-Key'));
  } catch (error) {
    throw new AppError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      error instanceof Error ? error.message : 'Invalid idempotency key'
    );
  }

  const uploadFingerprint = createUploadFingerprint(file);

  if (idempotencyKey) {
    const existingRecord = await getUploadIdempotencyRecord(
      dataAdapter,
      userId,
      libraryId,
      idempotencyKey
    );

    if (existingRecord) {
      if (!uploadFingerprintMatches(existingRecord.request, uploadFingerprint)) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSE_MISMATCH',
          'Idempotency key was already used with a different upload payload'
        );
      }

      res.status(200).json({
        ...(existingRecord.responseBody as Record<string, unknown>),
        idempotency: {
          key: idempotencyKey,
          replayed: true,
        },
      });
      return;
    }
  }

  try {
    // Generate unique photo ID
    const photoId = nanoid();

    // Extract metadata from image
    logger.info({ photoId, libraryId }, 'Extracting image metadata');
    const { extension, exifExtracted, ...metadata } = await extractMetadata(
      file.buffer,
      file.originalname,
      file.mimetype
    );

    // Build the normalized EXIF summary (small, stable subset) the way
    // issue #151 specifies.
    const normalizedExif = buildNormalizedExif(metadata.exif ?? null, {
      widthPx: metadata.width,
      heightPx: metadata.height,
    });

    // Generate storage paths
    const storagePaths = generatePhotoPaths(libraryId, photoId, extension);

    // Store original image
    logger.info({ photoId, path: storagePaths.original }, 'Storing original image');
    await storageAdapter.storeFile(storagePaths.original, file.buffer, {
      contentType: metadata.mimeType,
      customMetadata: {
        photoId,
        libraryId,
        originalName: file.originalname,
      },
    });

    // Create photo document
    const uploadIsRaw = isRawUpload(file.originalname, file.mimetype);

    const photo = createPhotoDocument(
      photoId,
      libraryId,
      file.originalname,
      storagePaths,
      metadata,
      uploadIsRaw
        ? {
            sourceType: 'raw',
            rawOriginal: {
              extension,
              mimeType: file.mimetype || metadata.mimeType,
            },
          }
        : { sourceType: 'raster' },
      undefined,
      normalizedExif
    );

    // Update status to processing (thumbnails will be generated next)
    photo.status = 'processing';
    photo.thumbnailsOutdated = true;

    // Save to database
    logger.info({ photoId }, 'Saving photo document');
    await dataAdapter.storeData('photos', photoId, photo);

    const responseBody = {
      photoId,
      status: 'processing',
      message: 'Photo uploaded successfully, thumbnails are being generated',
      photo: {
        id: photo.id,
        libraryId: photo.libraryId,
        originalName: photo.originalName,
        status: photo.status,
        metadata: photo.metadata,
        exif: photo.exif,
        createdAt: photo.createdAt,
      },
    };

    if (idempotencyKey) {
      await storeUploadIdempotencyRecord(dataAdapter, {
        key: idempotencyKey,
        userId,
        libraryId,
        request: uploadFingerprint,
        responseBody,
        createdAt: new Date().toISOString(),
      });
    }

    // Metering: record the accepted upload (count + bytes).
    emitMeteringEvent({
      tenantId,
      type: 'upload.accepted',
      count: 1,
      bytes: metadata.sizeBytes,
      resourceId: photoId,
      meta: {
        userId,
        libraryId,
        mimeType: metadata.mimeType,
        sourceType: uploadIsRaw ? 'raw' : 'raster',
        // Issue #151: surface EXIF + pixel dimensions so hosts can meter by
        // megapixel without a follow-up release.
        exifExtracted,
        ...(metadata.width ? { widthPx: metadata.width } : {}),
        ...(metadata.height ? { heightPx: metadata.height } : {}),
      },
    });

    // Issue #196: piggy-back per-tenant storage-threshold evaluation on
    // the upload path. Uses the post-upload usage estimate (pre-snapshot
    // we approximate by adding the new bytes to the in-memory reading we
    // just took). Best-effort — the evaluator swallows all errors so it
    // can never break an upload.
    if (
      usageDailyStore &&
      tenantRecord.quotaBytes !== null &&
      tenantRecord.quotaBytes > 0
    ) {
      const postUploadUsageBytes =
        (await readCurrentUsageBytes(usageDailyStore, tenantId)) +
        metadata.sizeBytes;
      // Don't await beyond a single tick — we want this off the
      // critical response path. `evaluateStorageThresholds` already
      // catches all errors internally.
      void evaluateStorageThresholds({
        dataAdapter,
        tenantId,
        usedBytes: postUploadUsageBytes,
        tenantRecord,
      });
    }

    // Return response immediately
    res.status(202).json({
      ...responseBody,
      ...(idempotencyKey
        ? {
            idempotency: {
              key: idempotencyKey,
              replayed: false,
            },
          }
        : {}),
    });

    // Trigger thumbnail generation in background
    // For now, we'll do it inline, but in production this would be a queue/event
    setImmediate(async () => {
      try {
        const { generateThumbnailsForPhoto } = await import(
          '../thumbnails/generate.js'
        );
        await generateThumbnailsForPhoto(
          photoId,
          libraryId,
          storageAdapter,
          dataAdapter
        );
      } catch (error) {
        logger.error(
          { err: error, photoId },
          'Failed to generate thumbnails in background'
        );
      }
    });
  } catch (error) {
    logger.error({ err: error, libraryId }, 'Upload failed');
    throw new AppError(
      500,
      'UPLOAD_FAILED',
      error instanceof Error ? error.message : 'Failed to upload photo'
    );
  }
}