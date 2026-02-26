import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errorHandler.js';

export interface SlidingWindowRateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

interface RateLimitEntry {
  timestamps: number[];
}

const requestBuckets = new Map<string, RateLimitEntry>();

function prune(entry: RateLimitEntry, now: number, windowMs: number): void {
  entry.timestamps = entry.timestamps.filter((timestamp) => now - timestamp < windowMs);
}

export function createSlidingWindowRateLimiter(options: SlidingWindowRateLimitOptions) {
  return function rateLimitMiddleware(req: Request, _res: Response, next: NextFunction): void {
    const userKey = req.user?.uid ?? req.ip ?? 'anonymous';
    const routeKey = req.route?.path ?? req.path;
    const key = `${userKey}:${routeKey}`;

    const now = Date.now();
    const bucket = requestBuckets.get(key) ?? { timestamps: [] };

    prune(bucket, now, options.windowMs);

    if (bucket.timestamps.length >= options.maxRequests) {
      const oldestInWindow = bucket.timestamps[0] ?? now;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((options.windowMs - (now - oldestInWindow)) / 1000)
      );
      throw new AppError(
        429,
        'RATE_LIMIT_EXCEEDED',
        `Too many requests. Try again in ${retryAfterSeconds} seconds.`
      );
    }

    bucket.timestamps.push(now);
    requestBuckets.set(key, bucket);
    next();
  };
}

export function clearRateLimitBuckets(): void {
  requestBuckets.clear();
}
