import { promises as fs } from 'fs';
import path from 'path';
import type { CacheLayer, CacheStats } from './CacheLayer.js';

interface CacheMetadata {
  expiresAt: number;
  size: number;
}

export class DiskCache implements CacheLayer {
  private hits = 0;
  private misses = 0;

  constructor(private readonly basePath: string) {}

  private getCachePath(key: string): string {
    // Replace slashes with underscores for filesystem compatibility
    const safeKey = key.replace(/\//g, '_');
    return path.join(this.basePath, safeKey);
  }

  private getMetadataPath(key: string): string {
    return `${this.getCachePath(key)}.meta.json`;
  }

  async get(key: string): Promise<Buffer | null> {
    const cachePath = this.getCachePath(key);
    const metaPath = this.getMetadataPath(key);

    try {
      // Read metadata
      const metaData = await fs.readFile(metaPath, 'utf-8');
      const metadata: CacheMetadata = JSON.parse(metaData);

      // Check if expired
      if (Date.now() > metadata.expiresAt) {
        await this.invalidate(key);
        this.misses++;
        return null;
      }

      // Read and return cached data
      const data = await fs.readFile(cachePath);
      this.hits++;
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.misses++;
        return null;
      }
      throw error;
    }
  }

  async set(key: string, data: Buffer, ttlSeconds: number): Promise<void> {
    const cachePath = this.getCachePath(key);
    const metaPath = this.getMetadataPath(key);
    const dir = path.dirname(cachePath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write data
    await fs.writeFile(cachePath, data);

    // Write metadata
    const metadata: CacheMetadata = {
      expiresAt: Date.now() + ttlSeconds * 1000,
      size: data.length,
    };
    await fs.writeFile(metaPath, JSON.stringify(metadata));
  }

  async invalidate(key: string): Promise<void> {
    const cachePath = this.getCachePath(key);
    const metaPath = this.getMetadataPath(key);

    try {
      await fs.unlink(cachePath);
    } catch {
      // Ignore if file doesn't exist
    }

    try {
      await fs.unlink(metaPath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.basePath, { recursive: true, force: true });
      await fs.mkdir(this.basePath, { recursive: true });
      this.hits = 0;
      this.misses = 0;
    } catch (error) {
      // Ignore if directory doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async getStats(): Promise<CacheStats> {
    let totalSize = 0;
    let count = 0;

    try {
      const files = await fs.readdir(this.basePath);
      
      for (const file of files) {
        if (file.endsWith('.meta.json')) continue;
        
        const filePath = path.join(this.basePath, file);
        const stat = await fs.stat(filePath);
        totalSize += stat.size;
        count++;
      }
    } catch {
      // Directory doesn't exist or is empty
    }

    return {
      size: count,
      hits: this.hits,
      misses: this.misses,
      evictions: 0, // Not tracked
    };
  }
}