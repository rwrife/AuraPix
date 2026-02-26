import { promises as fs } from 'fs';
import path from 'path';
import type { StorageAdapter, StorageMetadata } from './StorageAdapter.js';

export class LocalDiskStorage implements StorageAdapter {
  constructor(private readonly basePath: string) {}

  async storeFile(
    filePath: string,
    data: Buffer,
    metadata?: StorageMetadata
  ): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(fullPath, data);

    // Store metadata if provided (as a separate .meta.json file)
    if (metadata) {
      const metaPath = `${fullPath}.meta.json`;
      await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));
    }
  }

  async readFile(filePath: string): Promise<Buffer> {
    const fullPath = path.join(this.basePath, filePath);
    return await fs.readFile(fullPath);
  }

  async fileExists(filePath: string): Promise<boolean> {
    const fullPath = path.join(this.basePath, filePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    await fs.unlink(fullPath);

    // Also delete metadata file if it exists
    const metaPath = `${fullPath}.meta.json`;
    try {
      await fs.unlink(metaPath);
    } catch {
      // Ignore if metadata file doesn't exist
    }
  }

  async listFiles(prefix: string): Promise<string[]> {
    const fullPath = path.join(this.basePath, prefix);
    const files: string[] = [];

    try {
      const entries = await fs.readdir(fullPath, { recursive: true });
      
      for (const entry of entries) {
        const entryPath = path.join(fullPath, entry);
        const stat = await fs.stat(entryPath);
        
        if (stat.isFile() && !entry.endsWith('.meta.json')) {
          // Return path relative to basePath
          const relativePath = path.relative(this.basePath, entryPath);
          files.push(relativePath.replace(/\\/g, '/')); // Normalize to forward slashes
        }
      }
    } catch (error) {
      // Directory doesn't exist, return empty array
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    return files;
  }

  async getFileSize(filePath: string): Promise<number> {
    const fullPath = path.join(this.basePath, filePath);
    const stat = await fs.stat(fullPath);
    return stat.size;
  }
}