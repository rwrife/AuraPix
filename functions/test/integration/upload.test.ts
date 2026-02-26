import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { LocalDiskStorage } from '../../src/adapters/storage/LocalDiskStorage.js';
import { LocalJsonData } from '../../src/adapters/data/LocalJsonData.js';
import { generateThumbnailsForPhoto } from '../../src/handlers/thumbnails/generate.js';
import { createPhotoDocument } from '../../src/models/Photo.js';
import { generatePhotoPaths } from '../../src/config/storage-paths.js';
import type { Photo } from '../../src/models/Photo.js';

const TEST_STORAGE_PATH = './test-data/integration/storage';
const TEST_DATABASE_PATH = './test-data/integration/database';

// Simple 1x1 red pixel JPEG
const TEST_IMAGE_BUFFER = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
    'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
    'AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEB' +
    'AAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AAf/Z',
  'base64'
);

describe('Upload and Thumbnail Generation', () => {
  let storageAdapter: LocalDiskStorage;
  let dataAdapter: LocalJsonData;

  beforeEach(async () => {
    storageAdapter = new LocalDiskStorage(TEST_STORAGE_PATH);
    dataAdapter = new LocalJsonData(TEST_DATABASE_PATH);

    await fs.mkdir(TEST_STORAGE_PATH, { recursive: true });
    await fs.mkdir(TEST_DATABASE_PATH, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm('./test-data/integration', { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should store original and generate thumbnails', async () => {
    const libraryId = 'test-library-1';
    const photoId = 'test-photo-1';

    // Generate paths
    const storagePaths = generatePhotoPaths(libraryId, photoId, 'jpg');

    // Store original
    await storageAdapter.storeFile(
      storagePaths.original,
      TEST_IMAGE_BUFFER,
      {
        contentType: 'image/jpeg',
      }
    );

    // Create photo document
    const photo = createPhotoDocument(photoId, libraryId, 'test.jpg', storagePaths, {
      width: 1,
      height: 1,
      mimeType: 'image/jpeg',
      sizeBytes: TEST_IMAGE_BUFFER.length,
    });

    photo.status = 'processing';
    photo.thumbnailsOutdated = true;

    await dataAdapter.storeData('photos', photoId, photo);

    // Generate thumbnails
    await generateThumbnailsForPhoto(
      photoId,
      libraryId,
      storageAdapter,
      dataAdapter
    );

    // Verify all thumbnails were created
    const derivatives = storagePaths.derivatives;
    const checks = await Promise.all([
      storageAdapter.fileExists(derivatives.small_webp),
      storageAdapter.fileExists(derivatives.small_jpeg),
      storageAdapter.fileExists(derivatives.medium_webp),
      storageAdapter.fileExists(derivatives.medium_jpeg),
      storageAdapter.fileExists(derivatives.large_webp),
      storageAdapter.fileExists(derivatives.large_jpeg),
    ]);

    expect(checks.every((exists) => exists)).toBe(true);

    // Verify photo document was updated
    const updatedPhoto = await dataAdapter.fetchData<Photo>('photos', photoId);
    expect(updatedPhoto?.status).toBe('ready');
    expect(updatedPhoto?.thumbnailsOutdated).toBe(false);
  }, 10000); // 10 second timeout for image processing

  it('should be idempotent - skip if thumbnails already exist', async () => {
    const libraryId = 'test-library-2';
    const photoId = 'test-photo-2';

    const storagePaths = generatePhotoPaths(libraryId, photoId, 'jpg');

    // Store original
    await storageAdapter.storeFile(
      storagePaths.original,
      TEST_IMAGE_BUFFER
    );

    // Create ready photo with existing thumbnails
    const photo = createPhotoDocument(photoId, libraryId, 'test.jpg', storagePaths, {
      width: 1,
      height: 1,
      mimeType: 'image/jpeg',
      sizeBytes: TEST_IMAGE_BUFFER.length,
    });

    photo.status = 'ready';
    photo.thumbnailsOutdated = false;

    // Create dummy thumbnails
    await Promise.all(
      Object.values(storagePaths.derivatives).map((path) =>
        storageAdapter.storeFile(path, Buffer.from('dummy'))
      )
    );

    await dataAdapter.storeData('photos', photoId, photo);

    // Try to generate again - should skip
    await generateThumbnailsForPhoto(
      photoId,
      libraryId,
      storageAdapter,
      dataAdapter
    );

    // Verify thumbnails weren't regenerated (still contain 'dummy')
    const thumbnail = await storageAdapter.readFile(
      storagePaths.derivatives.small_webp
    );
    expect(thumbnail.toString()).toBe('dummy');
  });
});