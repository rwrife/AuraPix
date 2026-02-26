import { Bucket, Storage } from '@google-cloud/storage';
import { StorageAdapter, StorageMetadata } from './StorageAdapter.js';
import { logger } from '../../utils/logger.js';
import { AppError } from '../../middleware/errorHandler.js';

export interface FileMetadata {
  contentType?: string;
  size?: number;
  lastModified?: Date;
  customMetadata?: Record<string, string>;
}

export class FirebaseStorageAdapter implements StorageAdapter {
  private storage: Storage;
  private bucket: Bucket;

  constructor(bucketName: string) {
    this.storage = new Storage();
    this.bucket = this.storage.bucket(bucketName);
    
    logger.info({ bucketName }, 'Firebase Storage adapter initialized');
  }

  async storeFile(
    path: string,
    data: Buffer,
    metadata?: StorageMetadata
  ): Promise<void> {
    try {
      const file = this.bucket.file(path);
      
      const options: any = {
        metadata: {
          contentType: metadata?.contentType || 'application/octet-stream',
          metadata: metadata?.customMetadata || {},
        },
        resumable: false, // For small files
      };

      await file.save(data, options);
      
      logger.debug({ path, size: data.length }, 'File stored in Firebase Storage');
    } catch (error) {
      logger.error({ error, path }, 'Failed to store file in Firebase Storage');
      throw new AppError(
        500,
        'STORAGE_WRITE_ERROR',
        'Failed to store file in Firebase Storage'
      );
    }
  }

  async readFile(path: string): Promise<Buffer> {
    try {
      const file = this.bucket.file(path);
      const [exists] = await file.exists();
      
      if (!exists) {
        throw new AppError(404, 'FILE_NOT_FOUND', `File not found: ${path}`);
      }

      const [buffer] = await file.download();
      
      logger.debug({ path, size: buffer.length }, 'File read from Firebase Storage');
      return buffer;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logger.error({ error, path }, 'Failed to read file from Firebase Storage');
      throw new AppError(
        500,
        'STORAGE_READ_ERROR',
        'Failed to read file from Firebase Storage'
      );
    }
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      const file = this.bucket.file(path);
      const [exists] = await file.exists();
      return exists;
    } catch (error) {
      logger.error({ error, path }, 'Failed to check file existence');
      return false;
    }
  }

  async deleteFile(path: string): Promise<void> {
    try {
      const file = this.bucket.file(path);
      await file.delete({ ignoreNotFound: true });
      
      logger.debug({ path }, 'File deleted from Firebase Storage');
    } catch (error) {
      logger.error({ error, path }, 'Failed to delete file from Firebase Storage');
      throw new AppError(
        500,
        'STORAGE_DELETE_ERROR',
        'Failed to delete file from Firebase Storage'
      );
    }
  }

  async listFiles(prefix: string): Promise<string[]> {
    try {
      const [files] = await this.bucket.getFiles({ prefix });
      const filePaths = files.map((file) => file.name);
      
      logger.debug({ prefix, count: filePaths.length }, 'Files listed from Firebase Storage');
      return filePaths;
    } catch (error) {
      logger.error({ error, prefix }, 'Failed to list files from Firebase Storage');
      throw new AppError(
        500,
        'STORAGE_LIST_ERROR',
        'Failed to list files from Firebase Storage'
      );
    }
  }

  async getFileSize(path: string): Promise<number> {
    try {
      const file = this.bucket.file(path);
      const [metadata] = await file.getMetadata();
      return parseInt(metadata.size as string, 10);
    } catch (error) {
      logger.error({ error, path }, 'Failed to get file size from Firebase Storage');
      throw new AppError(
        500,
        'STORAGE_METADATA_ERROR',
        'Failed to get file size from Firebase Storage'
      );
    }
  }

  async getMetadata(path: string): Promise<FileMetadata | undefined> {
    try {
      const file = this.bucket.file(path);
      const [metadata] = await file.getMetadata();
      
      return {
        contentType: metadata.contentType,
        size: parseInt(metadata.size as string, 10),
        lastModified: new Date(metadata.updated as string),
        customMetadata: metadata.metadata || {},
      };
    } catch (error) {
      logger.error({ error, path }, 'Failed to get file metadata from Firebase Storage');
      return undefined;
    }
  }
}