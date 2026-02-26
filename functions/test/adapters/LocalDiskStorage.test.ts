import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { LocalDiskStorage } from '../../src/adapters/storage/LocalDiskStorage.js';

const TEST_BASE_PATH = './test-data/storage';

describe('LocalDiskStorage', () => {
  let storage: LocalDiskStorage;

  beforeEach(async () => {
    storage = new LocalDiskStorage(TEST_BASE_PATH);
    // Ensure test directory exists
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should store and read a file', async () => {
    const testPath = 'test/file.txt';
    const testData = Buffer.from('Hello, World!');

    await storage.storeFile(testPath, testData);
    const readData = await storage.readFile(testPath);

    expect(readData.toString()).toBe('Hello, World!');
  });

  it('should check if file exists', async () => {
    const testPath = 'test/exists.txt';
    const testData = Buffer.from('exists');

    expect(await storage.fileExists(testPath)).toBe(false);

    await storage.storeFile(testPath, testData);

    expect(await storage.fileExists(testPath)).toBe(true);
  });

  it('should delete a file', async () => {
    const testPath = 'test/delete.txt';
    const testData = Buffer.from('delete me');

    await storage.storeFile(testPath, testData);
    expect(await storage.fileExists(testPath)).toBe(true);

    await storage.deleteFile(testPath);
    expect(await storage.fileExists(testPath)).toBe(false);
  });

  it('should store and retrieve metadata', async () => {
    const testPath = 'test/with-meta.txt';
    const testData = Buffer.from('data');
    const metadata = {
      contentType: 'text/plain',
      customMetadata: { userId: '123' },
    };

    await storage.storeFile(testPath, testData, metadata);

    // Check metadata file was created
    const metaPath = path.join(TEST_BASE_PATH, testPath + '.meta.json');
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const storedMeta = JSON.parse(metaContent);

    expect(storedMeta.contentType).toBe('text/plain');
    expect(storedMeta.customMetadata?.userId).toBe('123');
  });

  it('should get file size', async () => {
    const testPath = 'test/size.txt';
    const testData = Buffer.from('0123456789'); // 10 bytes

    await storage.storeFile(testPath, testData);
    const size = await storage.getFileSize(testPath);

    expect(size).toBe(10);
  });

  it('should list files in directory', async () => {
    await storage.storeFile('dir/file1.txt', Buffer.from('1'));
    await storage.storeFile('dir/file2.txt', Buffer.from('2'));
    await storage.storeFile('dir/subdir/file3.txt', Buffer.from('3'));

    const files = await storage.listFiles('dir');

    expect(files).toHaveLength(3);
    expect(files).toContain('dir/file1.txt');
    expect(files).toContain('dir/file2.txt');
    expect(files).toContain('dir/subdir/file3.txt');
  });
});