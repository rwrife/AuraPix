import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../middleware/errorHandler.js';
import {
  handleApplyEdits,
  handleRevertVersion,
} from './applyEdits.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import type { Photo } from '../../models/Photo.js';

function createPhoto(): Photo {
  return {
    id: 'photo-1',
    libraryId: 'lib-1',
    albumIds: [],
    originalName: 'test.jpg',
    metadata: {
      width: 100,
      height: 100,
      mimeType: 'image/jpeg',
      sizeBytes: 123,
    },
    status: 'ready',
    currentEditVersion: 3,
    editHistory: [
      {
        version: 1,
        recipeVersion: 1,
        createdAt: new Date().toISOString(),
        createdBy: 'u1',
        operations: [],
      },
    ],
    thumbnailsOutdated: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createDataAdapter(photo: Photo): DataAdapter {
  return {
    storeData: vi.fn(),
    fetchData: vi.fn(async () => photo),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(),
    deleteData: vi.fn(),
    exists: vi.fn(async () => true),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => photo),
  };
}

function createStorageAdapter(): StorageAdapter {
  return {
    storeFile: vi.fn(),
    readFile: vi.fn(async () => Buffer.alloc(0)),
    fileExists: vi.fn(async () => true),
    deleteFile: vi.fn(),
    listFiles: vi.fn(async () => []),
    getFileSize: vi.fn(async () => 0),
  };
}

function createRes() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('edit conflict handling', () => {
  it('returns 409 when apply edits If-Match-Edit-Version does not match current version', async () => {
    const dataAdapter = createDataAdapter(createPhoto());
    const storageAdapter = createStorageAdapter();

    const req: any = {
      params: { libraryId: 'lib-1', photoId: 'photo-1' },
      user: { uid: 'user-1' },
      body: {
        recipeVersion: 1,
        operations: [{ type: 'rotate', params: { degrees: 90 }, order: 0 }],
      },
      header: (name: string) =>
        name === 'If-Match-Edit-Version' ? '2' : undefined,
      app: { locals: { dataAdapter, storageAdapter } },
    };

    const res = createRes();

    await expect(handleApplyEdits(req, res as any)).rejects.toMatchObject({
      statusCode: 409,
      code: 'EDIT_VERSION_CONFLICT',
    } satisfies Partial<AppError>);
    expect((dataAdapter.updateData as any).mock.calls.length).toBe(0);
  });

  it('returns 400 when If-Match-Edit-Version is invalid', async () => {
    const req: any = {
      params: { libraryId: 'lib-1', photoId: 'photo-1' },
      user: { uid: 'user-1' },
      body: {
        recipeVersion: 1,
        operations: [{ type: 'rotate', params: { degrees: 90 }, order: 0 }],
      },
      header: (name: string) =>
        name === 'If-Match-Edit-Version' ? 'abc' : undefined,
      app: { locals: { dataAdapter: createDataAdapter(createPhoto()), storageAdapter: createStorageAdapter() } },
    };

    await expect(handleApplyEdits(req, createRes() as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_IF_MATCH_EDIT_VERSION',
    } satisfies Partial<AppError>);
  });

  it('returns 409 when revert If-Match-Edit-Version does not match current version', async () => {
    const dataAdapter = createDataAdapter(createPhoto());

    const req: any = {
      params: { libraryId: 'lib-1', photoId: 'photo-1' },
      user: { uid: 'user-1' },
      body: { targetVersion: 1 },
      header: (name: string) =>
        name === 'If-Match-Edit-Version' ? '99' : undefined,
      app: {
        locals: {
          dataAdapter,
          storageAdapter: createStorageAdapter(),
        },
      },
    };

    await expect(handleRevertVersion(req, createRes() as any)).rejects.toMatchObject({
      statusCode: 409,
      code: 'EDIT_VERSION_CONFLICT',
    } satisfies Partial<AppError>);
    expect((dataAdapter.updateData as any).mock.calls.length).toBe(0);
  });
});
