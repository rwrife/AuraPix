import type { CacheLayer } from '../../adapters/cache/CacheLayer.js';
import { MemoryCache } from '../../adapters/cache/MemoryCache.js';
import { DiskCache } from '../../adapters/cache/DiskCache.js';
import { cacheConfig, storageConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

/**
 * Multi-tier image cache coordinator
 */
export class ImageCache {
  private memoryCache: CacheLayer;
  private diskCache: CacheLayer;

  constructor() {
    this.memoryCache = new MemoryCache(cacheConfig.memory.maxSizeMB);
    this.diskCache = new DiskCache(storageConfig.local.cachePath);
  }

  /**
   * Generate cache key from photo parameters
   */
  private getCacheKey(
    photoId: string,
    size: string,
    format: string,
    version: number
  ): string {
    return `${photoId}/${size}/${format}/v${version}`;
  }

  /**
   * Get image from cache (checks memory, then disk)
   */
  async get(
    photoId: string,
    size: string,
    format: string,
    version: number
  ): Promise<Buffer | null> {
    const key = this.getCacheKey(photoId, size, format, version);

    // Try memory cache first
    const memoryHit = await this.memoryCache.get(key);
    if (memoryHit) {
      logger.debug({ photoId, size, format, version }, 'Memory cache hit');
      return memoryHit;
    }

    // Try disk cache
    const diskHit = await this.diskCache.get(key);
    if (diskHit) {
      logger.debug({ photoId, size, format, version }, 'Disk cache hit');
      // Promote to memory cache
      await this.memoryCache.set(
        key,
        diskHit,
        cacheConfig.memory.ttlSeconds
      );
      return diskHit;
    }

    logger.debug({ photoId, size, format, version }, 'Cache miss');
    return null;
  }

  /**
   * Store image in both cache tiers
   */
  async set(
    photoId: string,
    size: string,
    format: string,
    version: number,
    data: Buffer
  ): Promise<void> {
    const key = this.getCacheKey(photoId, size, format, version);

    // Store in both caches
    await Promise.all([
      this.memoryCache.set(key, data, cacheConfig.memory.ttlSeconds),
      this.diskCache.set(key, data, cacheConfig.disk.ttlSeconds),
    ]);

    logger.debug(
      { photoId, size, format, version, bytes: data.length },
      'Cached image'
    );
  }

  /**
   * Invalidate all cached versions of a photo
   */
  async invalidatePhoto(photoId: string): Promise<void> {
    // Note: Current implementation doesn't support pattern-based invalidation
    // In production, you might want to track cache keys or use Redis with pattern matching
    logger.info({ photoId }, 'Photo cache invalidation requested');
    // For now, we'll rely on TTL expiration
  }

  /**
   * Clear all caches
   */
  async clear(): Promise<void> {
    await Promise.all([this.memoryCache.clear(), this.diskCache.clear()]);
    logger.info('All caches cleared');
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    const [memoryStats, diskStats] = await Promise.all([
      this.memoryCache.getStats(),
      this.diskCache.getStats(),
    ]);

    return {
      memory: memoryStats,
      disk: diskStats,
    };
  }
}

// Singleton instance
let imageCacheInstance: ImageCache | null = null;

export function getImageCache(): ImageCache {
  if (!imageCacheInstance) {
    imageCacheInstance = new ImageCache();
  }
  return imageCacheInstance;
}