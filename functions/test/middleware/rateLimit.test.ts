import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { AppError } from '../../src/middleware/errorHandler.js';
import {
  clearRateLimitBuckets,
  createSlidingWindowRateLimiter,
} from '../../src/middleware/rateLimit.js';

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    path: '/images/library-1',
    route: { path: '/:libraryId' },
    ip: '127.0.0.1',
    user: { uid: 'local-user-1' },
    ...overrides,
  } as unknown as Request;
}

describe('createSlidingWindowRateLimiter', () => {
  beforeEach(() => {
    clearRateLimitBuckets();
    vi.useRealTimers();
  });

  it('allows requests under the limit', () => {
    const limiter = createSlidingWindowRateLimiter({
      windowMs: 1000,
      maxRequests: 2,
    });
    const next = vi.fn();

    limiter(makeRequest(), {} as Response, next);
    limiter(makeRequest(), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('throws a 429 AppError after exceeding the limit', () => {
    const limiter = createSlidingWindowRateLimiter({
      windowMs: 1000,
      maxRequests: 1,
    });

    limiter(makeRequest(), {} as Response, vi.fn());

    expect(() => limiter(makeRequest(), {} as Response, vi.fn())).toThrowError(AppError);

    try {
      limiter(makeRequest(), {} as Response, vi.fn());
    } catch (error) {
      const appError = error as AppError;
      expect(appError.statusCode).toBe(429);
      expect(appError.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(appError.message).toContain('Try again in');
    }
  });

  it('resets allowance after the window expires', () => {
    vi.useFakeTimers();

    const limiter = createSlidingWindowRateLimiter({
      windowMs: 1000,
      maxRequests: 1,
    });

    limiter(makeRequest(), {} as Response, vi.fn());
    expect(() => limiter(makeRequest(), {} as Response, vi.fn())).toThrowError(AppError);

    vi.advanceTimersByTime(1001);

    expect(() => limiter(makeRequest(), {} as Response, vi.fn())).not.toThrow();
  });
});
