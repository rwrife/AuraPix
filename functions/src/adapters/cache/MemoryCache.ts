import { LRUCache } from 'lru-cache';
import type { CacheLayer, CacheStats } from './CacheLayer.js';

interface CacheEntry {
  data: Buffer;
  expiresAt: number;
}

export class MemoryCache implements CacheLayer {
  private cache: LRUCache<string, CacheEntry>;
  private hits = 0;
  private misses = 0;

  constructor(maxSizeMB: number) {
    const maxSizeBytes = maxSizeMB * 1024 * 1024;

    this.cache = new LRUCache<string, CacheEntry>({
      max: 500, // Max number of entries
      maxSize: maxSizeBytes,
      sizeCalculation: (entry) => entry.data.length,
      dispose: () => {
        // Could track evictions here if needed
      },
    });
  }

  async get(key: string): Promise<Buffer | null> {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.data;
  }

  async set(key: string, data: Buffer, ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.cache.set(key, { data, expiresAt });
  }

  async invalidate(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  async getStats(): Promise<CacheStats> {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      evictions: 0, // LRUCache doesn't expose this directly
    };
  }
}