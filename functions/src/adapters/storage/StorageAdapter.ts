/**
 * Abstract storage interface for host-agnostic file operations.
 * Implementations: LocalDiskStorage (dev), FirebaseStorage (prod)
 */

export interface StorageMetadata {
  contentType?: string;
  cacheControl?: string;
  customMetadata?: Record<string, string>;
}

export interface StorageAdapter {
  /**
   * Store a file at the specified path
   */
  storeFile(
    path: string,
    data: Buffer,
    metadata?: StorageMetadata
  ): Promise<void>;

  /**
   * Read a file from the specified path
   */
  readFile(path: string): Promise<Buffer>;

  /**
   * Check if a file exists
   */
  fileExists(path: string): Promise<boolean>;

  /**
   * Delete a file
   */
  deleteFile(path: string): Promise<void>;

  /**
   * List files with a given prefix
   */
  listFiles(prefix: string): Promise<string[]>;

  /**
   * Get file size in bytes
   */
  getFileSize(path: string): Promise<number>;
}