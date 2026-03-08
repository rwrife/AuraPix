import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../middleware/errorHandler.js';
import { handleUpload } from './upload.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';

function createDataAdapter(): DataAdapter {
  return {
    storeData: vi.fn(),
    fetchData: vi.fn(async () => null),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(),
    deleteData: vi.fn(),
    exists: vi.fn(async () => false),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => null),
  };
}

function createStorageAdapter(): StorageAdapter {
  return {
    storeFile: vi.fn(),
    readFile: vi.fn(async () => Buffer.alloc(0)),
    fileExists: vi.fn(async () => false),
    deleteFile: vi.fn(),
    listFiles: vi.fn(async () => []),
    getFileSize: vi.fn(async () => 0),
  };
}

describe('handleUpload validation', () => {
  it('returns 400 INVALID_IDEMPOTENCY_KEY for overly long keys', async () => {
    const req: any = {
      params: { libraryId: 'lib-1' },
      user: { uid: 'user-1' },
      file: {
        originalname: 'photo.jpg',
        mimetype: 'image/jpeg',
        size: 123,
        buffer: Buffer.from('abc'),
      },
      header: (name: string) =>
        name === 'Idempotency-Key' ? 'x'.repeat(129) : undefined,
      app: {
        locals: {
          storageAdapter: createStorageAdapter(),
          dataAdapter: createDataAdapter(),
        },
      },
    };

    await expect(handleUpload(req, {} as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_IDEMPOTENCY_KEY',
    } satisfies Partial<AppError>);
  });

  it('accepts RAW uploads identified by extension with generic mime type', async () => {
    const req: any = {
      params: { libraryId: 'lib-1' },
      user: { uid: 'user-1' },
      file: {
        originalname: 'nikon.nef',
        mimetype: 'application/octet-stream',
        size: 128,
        buffer: Buffer.from('raw-data'),
      },
      header: () => undefined,
      app: {
        locals: {
          storageAdapter: createStorageAdapter(),
          dataAdapter: createDataAdapter(),
        },
      },
    };

    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res: any = { status, json };

    await expect(handleUpload(req, res)).resolves.toBeUndefined();
    expect(status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'processing',
      })
    );
  });
});
