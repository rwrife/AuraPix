/**
 * Abstract cache interface for multi-tier caching strategy
 */

export interface CacheLayer {
  /**
   * Get a value from cache
   */
  get(key: string): Promise<Buffer | null>;

  /**
   * Set a value in cache with TTL
   */
  set(key: string, data: Buffer, ttlSeconds: number): Promise<void>;

  /**
   * Invalidate a cache entry
   */
  invalidate(key: string): Promise<void>;

  /**
   * Clear all cache entries
   */
  clear(): Promise<void>;

  /**
   * Get cache statistics
   */
  getStats(): Promise<CacheStats>;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}