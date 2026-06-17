/**
 * Idempotency-Key middleware for mutating host API endpoints (issue #162).
 *
 * Hosts that call AuraPix server-to-server need safe retries: without an
 * idempotency mechanism, a retried POST after a network blip can create
 * duplicate albums, duplicate uploads, or double-charge metered actions.
 *
 * This middleware implements the standard Stripe/IETF-draft pattern:
 *
 *   1. Caller sends `Idempotency-Key: <opaque>` on a mutating request.
 *   2. We hash the request body and look up `(tenantId, route, key)` in the
 *      idempotency store.
 *   3. First call: forward to the handler, capture the response
 *      (status + JSON body + body hash) and persist it with a 24h TTL.
 *   4. Retry with the SAME body hash within the TTL: short-circuit and
 *      return the cached response. The downstream handler is NOT invoked,
 *      so metering events are NOT re-emitted.
 *   5. Retry with a DIFFERENT body hash: return `409 IDEMPOTENCY_KEY_CONFLICT`.
 *
 * Tenant isolation:
 *   - Records are namespaced per tenant via a composite SHA-256 id
 *     `sha256(tenantId:route:key)`. Cross-tenant collisions are impossible
 *     even for identical keys.
 *   - The `tenantId` field is also written verbatim onto every record so
 *     bulk tenant offboarding can purge with a single equality query.
 *
 * Metering protection:
 *   - The original handler is the ONLY codepath that emits metering events
 *     for a given key. Cached replays bypass it entirely.
 *   - On a cached replay we emit a single, low-volume `idempotency.replayed`
 *     debug-tier event so hosts can observe client retry behavior. This
 *     event is NOT billable.
 *
 * Opt-in:
 *   - Apply this middleware only to mutating routes via the
 *     `createIdempotencyMiddleware` factory; an explicit allow-list keeps
 *     the surface area small and auditable.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { logger } from '../utils/logger.js';
import { emitMeteringEvent } from '../services/metering/index.js';

/** Firestore collection holding cached idempotent responses. */
export const IDEMPOTENCY_COLLECTION = 'idempotency_keys';

/** Header carrying the caller-supplied idempotency key. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Response header set on cached replays so callers can observe deduplication. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/** Spec cap on key length (opaque, UUID-friendly). */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Default cache TTL — 24 hours, per issue #162. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Conflict error code emitted when the same key is reused with a different
 * request body. Documented in `docs/features/idempotency-keys.md`.
 */
export const IDEMPOTENCY_CONFLICT_CODE = 'IDEMPOTENCY_KEY_CONFLICT';

/** Persisted record. Kept small: status, headers subset, body, hash, ttl. */
export interface IdempotencyRecord {
  /** Caller-supplied key (raw, normalized — trimmed; case-preserved). */
  key: string;
  /** Tenant the record belongs to. Used for offboarding purges. */
  tenantId: string;
  /** Route identity, e.g. `POST /api/v1/albums`. Part of the lookup key. */
  route: string;
  /** SHA-256 hex of the canonicalized request body. */
  bodyHash: string;
  /** Captured response status code (e.g. 200, 201, 204). */
  status: number;
  /** Captured JSON body (null when the original sent no body, e.g. 204). */
  body: unknown | null;
  /** Subset of response headers worth replaying. Keep small. */
  headers: Record<string, string>;
  /** When the record was first written. ISO-8601. */
  createdAt: string;
  /** Hard expiry; reads past this are treated as cache miss. ISO-8601. */
  expiresAt: string;
}

/** Options for the per-route middleware factory. */
export interface IdempotencyMiddlewareOptions {
  /**
   * Stable route identity used in the storage key and replayed event meta.
   * Pick a short, descriptive value, e.g. `POST /api/v1/albums`. The actual
   * URL path is also fine but using a stable identifier is more resilient
   * to path-param differences.
   */
  route: string;
  /** Persistence layer; pulled from `app.locals.dataAdapter`. */
  dataAdapter: DataAdapter;
  /** Override TTL (ms). Defaults to {@link DEFAULT_IDEMPOTENCY_TTL_MS}. */
  ttlMs?: number;
  /**
   * Optional override for tenant resolution. Defaults to the standard
   * resolver: `req.tenant?.id ?? req.user?.uid`. Returning `null` or an
   * empty string disables idempotency for that request (middleware
   * passes through).
   */
  resolveTenantId?: (req: Request) => string | null | undefined;
}

/**
 * Resolve the tenant the request belongs to. Mirrors the convention used in
 * `routes/tenantUsage.ts` where the authenticated user's uid is treated as
 * their own tenantId until a first-class tenant model lands. Host-key
 * authentication takes precedence when present.
 */
export function defaultResolveTenantId(req: Request): string | null {
  if (req.tenant?.id) return req.tenant.id;
  if (req.user?.uid) return req.user.uid;
  return null;
}

/**
 * Canonicalize a JS value so structurally equal bodies hash to the same
 * digest regardless of object key order. Arrays preserve order (semantic).
 * Booleans, null, numbers, and strings hash by value. Functions/undefined
 * are dropped to match `JSON.stringify`.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** SHA-256 hex of the canonicalized request body. */
export function hashRequestBody(body: unknown): string {
  const canonical = canonicalize(body ?? null);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Normalize an `Idempotency-Key` header value. Returns `null` when absent
 * or empty (caller MUST treat as opt-out). Throws when the key exceeds
 * {@link MAX_IDEMPOTENCY_KEY_LENGTH} characters — callers map this to a 400.
 */
export function getNormalizedIdempotencyKey(
  headerValue: string | string[] | undefined
): string | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new IdempotencyKeyTooLongError(
      `Idempotency-Key exceeds ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`
    );
  }
  return trimmed;
}

export class IdempotencyKeyTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyKeyTooLongError';
  }
}

/**
 * Build the storage record id. SHA-256 over `tenantId:route:key` keeps the
 * id collision-free and namespaced per tenant so cross-tenant
 * collisions are impossible even for identical caller-supplied keys.
 */
export function buildRecordId(tenantId: string, route: string, key: string): string {
  return createHash('sha256').update(`${tenantId}:${route}:${key}`).digest('hex');
}

/** Returns true when the persisted record's `expiresAt` is in the past. */
export function isExpired(record: IdempotencyRecord, now = Date.now()): boolean {
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

/** Headers we will replay verbatim on a cached response. Keep this list tiny. */
const REPLAYABLE_HEADERS = new Set<string>(['content-type', 'location', 'etag']);

function extractReplayableHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of REPLAYABLE_HEADERS) {
    const v = res.getHeader(name);
    if (typeof v === 'string') {
      out[name] = v;
    } else if (typeof v === 'number') {
      out[name] = String(v);
    }
  }
  return out;
}

function applyReplayedHeaders(
  res: Response,
  headers: Record<string, string>
): void {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

function sendErrorEnvelope(
  res: Response,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> | null = null
): void {
  res.status(status).json({
    error: {
      code,
      message,
      requestId: randomUUID(),
      details,
    },
  });
}

/**
 * Express middleware factory. Wraps a single mutating route with
 * `Idempotency-Key` support. Pass-through when no key is supplied so
 * existing callers are unaffected.
 *
 * Usage:
 *   app.post(
 *     '/api/v1/albums',
 *     authMiddleware,
 *     createIdempotencyMiddleware({
 *       route: 'POST /api/v1/albums',
 *       dataAdapter,
 *     }),
 *     handler,
 *   );
 */
export function createIdempotencyMiddleware(
  options: IdempotencyMiddlewareOptions
) {
  const {
    route,
    dataAdapter,
    ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
    resolveTenantId = defaultResolveTenantId,
  } = options;

  return async function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    let key: string | null;
    try {
      key = getNormalizedIdempotencyKey(req.headers[IDEMPOTENCY_HEADER]);
    } catch (err) {
      if (err instanceof IdempotencyKeyTooLongError) {
        sendErrorEnvelope(res, 400, 'INVALID_IDEMPOTENCY_KEY', err.message);
        return;
      }
      next(err);
      return;
    }

    // No key supplied → opt-out, behave like a normal route.
    if (!key) {
      next();
      return;
    }

    const tenantId = resolveTenantId(req) ?? null;
    if (!tenantId) {
      // Without a tenant we cannot scope the key safely. Pass through
      // instead of accidentally deduplicating across tenants.
      logger.debug(
        { route, hasUser: Boolean(req.user), hasTenant: Boolean(req.tenant) },
        'Idempotency key supplied without a resolvable tenant; passing through'
      );
      next();
      return;
    }

    const bodyHash = hashRequestBody(req.body);
    const recordId = buildRecordId(tenantId, route, key);

    // Look up an existing record. Failures here are logged but do NOT
    // block the request — falling through to the handler is strictly safer
    // than a 500 on a store outage.
    let existing: IdempotencyRecord | null = null;
    try {
      existing = await dataAdapter.fetchData<IdempotencyRecord>(
        IDEMPOTENCY_COLLECTION,
        recordId
      );
    } catch (err) {
      logger.warn(
        { err, route, tenantId },
        'Idempotency store lookup failed; proceeding without dedup'
      );
    }

    if (existing && !isExpired(existing)) {
      if (existing.bodyHash !== bodyHash) {
        sendErrorEnvelope(
          res,
          409,
          IDEMPOTENCY_CONFLICT_CODE,
          'Idempotency-Key reused with a different request body',
          { route, key }
        );
        return;
      }

      // Cached replay — short-circuit the handler entirely so metering
      // events are not re-emitted.
      applyReplayedHeaders(res, existing.headers);
      res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      try {
        // Low-volume debug event so hosts can monitor client retries.
        // NOT billable; consumers should filter it out of billable rollups.
        emitMeteringEvent({
          tenantId,
          type: 'idempotency.replayed',
          count: 1,
          meta: { route, key },
        });
      } catch {
        // emit is fire-and-forget; never block the response.
      }
      if (existing.body === null || existing.body === undefined) {
        res.status(existing.status).send();
      } else {
        res.status(existing.status).json(existing.body);
      }
      return;
    }

    // First call (or expired record). Intercept the response so we can
    // persist it before the connection is closed.
    let capturedStatus = 200;
    let capturedBody: unknown | null = null;
    let captured = false;

    const originalStatus = res.status.bind(res);
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.status = function (code: number): Response {
      capturedStatus = code;
      return originalStatus(code);
    } as Response['status'];

    res.json = function (body: unknown): Response {
      capturedBody = body;
      captured = true;
      return originalJson(body as never);
    } as Response['json'];

    res.send = function (body?: unknown): Response {
      // Only treat empty/204-style sends as "captured but bodyless"; if a
      // route uses `res.send(string)` (rare for our JSON API) we still
      // record the value so replays match.
      if (!captured) {
        capturedBody = body === undefined ? null : (body as unknown);
        captured = true;
      }
      return originalSend(body as never);
    } as Response['send'];

    // Persist after the response is on the wire so we never block the
    // client on a store write. Failures here only impact future retries
    // (they'd re-execute the handler instead of replaying).
    res.on('finish', () => {
      if (!captured) return;
      // Only cache success-ish responses. 4xx/5xx are not replayed so a
      // client can retry and recover with a corrected payload.
      if (capturedStatus < 200 || capturedStatus >= 300) return;

      const now = new Date();
      const record: IdempotencyRecord = {
        key,
        tenantId,
        route,
        bodyHash,
        status: capturedStatus,
        body: capturedBody ?? null,
        headers: extractReplayableHeaders(res),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };

      void dataAdapter
        .storeData(IDEMPOTENCY_COLLECTION, recordId, record)
        .catch((err) => {
          logger.warn(
            { err, route, tenantId, recordId },
            'Failed to persist idempotency record; future retries will re-execute'
          );
        });
    });

    next();
  };
}
