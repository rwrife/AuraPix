import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errorHandler.js';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import type { UsageMeteringBus } from '../services/metering/UsageMeteringBus.js';
import { logger } from '../utils/logger.js';

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

// -----------------------------------------------------------------------------
// Per-tenant token-bucket limiter (issue #154)
// -----------------------------------------------------------------------------
//
// Best-effort, in-process limiter keyed strictly by `tenantId` so one
// tenant's traffic can never consume another tenant's tokens. Correctness
// for billing/quotas lives in per-tenant Firestore quotas and the metering
// rollup; this middleware exists only to shed obvious abuse / runaway
// scripts at the edge before they saturate the function instance.
//
// The bucket fills at `rps` tokens/second up to `burst` capacity. Each
// admitted request consumes 1 token. When the bucket is empty we respond
// with 429 + `Retry-After` and emit a sampled `rate_limit.exceeded`
// metering event (≤1/sec/tenant) so the host can chart abuse.
//
// State is per-instance; this is intentional. Token buckets converge
// quickly under sustained load and the metering rollup gives hosts the
// real signal.

export interface TokenBucketRateLimitOptions {
  /** Default tokens-per-second refill for user traffic. */
  rps: number;
  /** Default bucket capacity for user traffic. */
  burst: number;
  /**
   * Optional higher refill rate for trusted host API key traffic
   * (Authorization: Bearer ak_live_...). Falls back to `rps` when unset.
   */
  hostRps?: number;
  /**
   * Optional DataAdapter used to read per-tenant overrides from the
   * `tenants_config` collection. Overrides are honored on the next request
   * (no restart) and cached for a short TTL to avoid hammering Firestore.
   */
  dataAdapter?: DataAdapter;
  /**
   * Optional metering bus. When set, the limiter publishes a sampled
   * `rate_limit.exceeded` event (≤1/sec/tenant) on overflow.
   */
  meteringBus?: UsageMeteringBus;
  /** Test seam. Defaults to Date.now(). */
  now?: () => number;
  /** Test seam. TTL (ms) for the tenant-override cache. Default 5s. */
  overrideCacheTtlMs?: number;
}

/** Shape of a `tenants_config` doc relevant to this limiter. */
export interface TenantRateLimitConfigDoc {
  rateLimit?: {
    rps?: number;
    burst?: number;
  };
}

export const TENANT_CONFIG_COLLECTION = 'tenants_config';

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
  /** Last time we emitted a `rate_limit.exceeded` event for this tenant. */
  lastEventMs: number;
}

interface CachedOverride {
  rps?: number;
  burst?: number;
  fetchedAtMs: number;
}

const tokenBuckets = new Map<string, TokenBucket>();
const overrideCache = new Map<string, CachedOverride>();
const inflightOverrideFetches = new Map<string, Promise<CachedOverride>>();

export function clearTokenBuckets(): void {
  tokenBuckets.clear();
  overrideCache.clear();
  inflightOverrideFetches.clear();
}

function refill(bucket: TokenBucket, capacity: number, rps: number, nowMs: number): void {
  const elapsedSec = (nowMs - bucket.lastRefillMs) / 1000;
  if (elapsedSec <= 0) return;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * rps);
  bucket.lastRefillMs = nowMs;
}

async function loadOverride(
  tenantId: string,
  dataAdapter: DataAdapter,
  nowMs: number,
  ttlMs: number
): Promise<CachedOverride> {
  const cached = overrideCache.get(tenantId);
  if (cached && nowMs - cached.fetchedAtMs < ttlMs) {
    return cached;
  }
  const inflight = inflightOverrideFetches.get(tenantId);
  if (inflight) return inflight;

  const p = (async (): Promise<CachedOverride> => {
    let rps: number | undefined;
    let burst: number | undefined;
    try {
      const doc = await dataAdapter.fetchData<TenantRateLimitConfigDoc>(
        TENANT_CONFIG_COLLECTION,
        tenantId
      );
      if (doc?.rateLimit) {
        if (typeof doc.rateLimit.rps === 'number' && doc.rateLimit.rps > 0) {
          rps = doc.rateLimit.rps;
        }
        if (typeof doc.rateLimit.burst === 'number' && doc.rateLimit.burst > 0) {
          burst = doc.rateLimit.burst;
        }
      }
    } catch (err) {
      // Best-effort: a config-doc read failure should never block requests.
      logger.debug({ err, tenantId }, 'tenant rate-limit override fetch failed');
    }
    const entry: CachedOverride = { rps, burst, fetchedAtMs: nowMs };
    overrideCache.set(tenantId, entry);
    return entry;
  })();
  inflightOverrideFetches.set(tenantId, p);
  try {
    return await p;
  } finally {
    inflightOverrideFetches.delete(tenantId);
  }
}

/**
 * Stable JSON error body for 429 responses. Kept narrow on purpose so
 * client SDKs can pattern-match the `code` without parsing free-form text.
 */
export function buildRateLimitErrorBody(retryAfterSeconds: number) {
  return {
    error: 'Rate limit exceeded',
    code: 'RATE_LIMIT_EXCEEDED',
    statusCode: 429,
    retryAfterSeconds,
  };
}

/**
 * Per-tenant token-bucket rate limit middleware. MUST be mounted after
 * `resolveTenant` so `req.tenantId` is populated.
 */
export function createTenantTokenBucketRateLimiter(
  options: TokenBucketRateLimitOptions
) {
  const defaultRps = options.rps;
  const defaultBurst = options.burst;
  const hostRps = options.hostRps ?? options.rps;
  const ttlMs = options.overrideCacheTtlMs ?? 5_000;
  const nowFn = options.now ?? (() => Date.now());

  return async function tenantRateLimit(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const tenantId = req.tenantId;
    if (!tenantId) {
      // resolveTenant should always set this; if not, skip silently rather
      // than 500 — auth/validation will reject the request downstream.
      next();
      return;
    }

    const isHostKey = Boolean(req.tenant?.keyId);
    const principal: 'user' | 'hostKey' = isHostKey ? 'hostKey' : 'user';

    // Resolve effective rps/burst. Host API key callers use a separate,
    // higher bucket so trusted machine traffic is not throttled by
    // end-user limits. Per-tenant override doc (if any) wins over env
    // defaults for user traffic; host-key traffic always uses hostRps but
    // can still be capacity-bounded by an explicit override burst.
    let effRps = isHostKey ? hostRps : defaultRps;
    let effBurst = defaultBurst;

    if (!isHostKey && options.dataAdapter) {
      const override = await loadOverride(
        tenantId,
        options.dataAdapter,
        nowFn(),
        ttlMs
      );
      if (override.rps !== undefined) effRps = override.rps;
      if (override.burst !== undefined) effBurst = override.burst;
    } else if (isHostKey && options.dataAdapter) {
      const override = await loadOverride(
        tenantId,
        options.dataAdapter,
        nowFn(),
        ttlMs
      );
      if (override.burst !== undefined) effBurst = override.burst;
    }

    if (effRps <= 0 || effBurst <= 0) {
      // Defensive: misconfigured to disabled — let the request through.
      next();
      return;
    }

    // Bucket key includes principal so host-key traffic and user traffic
    // do not drain each other.
    const key = `${tenantId}:${principal}`;
    const nowMs = nowFn();
    let bucket = tokenBuckets.get(key);
    if (!bucket) {
      bucket = { tokens: effBurst, lastRefillMs: nowMs, lastEventMs: 0 };
      tokenBuckets.set(key, bucket);
    }
    refill(bucket, effBurst, effRps, nowMs);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      next();
      return;
    }

    // Overflow: compute Retry-After (whole seconds, min 1).
    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterSeconds = Math.max(1, Math.ceil(tokensNeeded / effRps));

    // Sampled metering event (≤1/sec/tenant).
    if (options.meteringBus && nowMs - bucket.lastEventMs >= 1000) {
      bucket.lastEventMs = nowMs;
      const route = req.route?.path ?? req.path;
      // Fire-and-forget; never let event publishing block the response.
      void options.meteringBus
        .publish({
          tenantId,
          counter: 'rateLimited',
          value: 1,
          meta: { event: 'rate_limit.exceeded', route, principal },
        })
        .catch((err) => {
          logger.debug({ err, tenantId }, 'rate_limit.exceeded publish failed');
        });
    }

    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json(buildRateLimitErrorBody(retryAfterSeconds));
  };
}

/**
 * Helper for tests / introspection: peek at a tenant's bucket state.
 */
export function getTokenBucketState(
  tenantId: string,
  principal: 'user' | 'hostKey' = 'user'
): { tokens: number; lastRefillMs: number } | null {
  const b = tokenBuckets.get(`${tenantId}:${principal}`);
  if (!b) return null;
  return { tokens: b.tokens, lastRefillMs: b.lastRefillMs };
}

