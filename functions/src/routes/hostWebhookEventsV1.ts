/**
 * Public host webhook event catalog endpoint (issue #176).
 *
 *   GET /v1/host/webhook-events
 *
 * Returns the machine-readable catalog of every metering / webhook event
 * AuraPix can emit, plus the JSON Schema for each event's `meta` payload
 * and a `catalogVersion` cache key. Hosts use this to:
 *
 *   1. Build a billing pipeline without scraping the docs.
 *   2. Detect new event types AuraPix adds over time (compare
 *      `catalogVersion` against the one in their cached snapshot OR
 *      against the `catalogVersion` field in every outbound webhook
 *      envelope).
 *   3. Validate incoming webhook payloads against the published schema.
 *
 * Auth: host API key (Authorization: Bearer ak_live_...). The catalog is
 * GLOBAL (not per-tenant), so we don't require any specific scope \u2014 just
 * a valid host key to keep the roadmap out of fully-anonymous hands. The
 * response is identical for every host and is safe to cache at the edge.
 *
 * ETag: deterministic; derived from the `catalogVersion` and a SHA-256 of
 * the canonical JSON body. Clients SHOULD send `If-None-Match` to get a
 * 304 when the catalog has not changed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  CATALOG_VERSION,
  getEventCatalogResponse,
} from '../services/metering/eventCatalog.js';

interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: Record<string, unknown> | null;
  };
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> | null = null
): void {
  const body: ApiErrorPayload = {
    error: { code, message, requestId: randomUUID(), details },
  };
  res.status(status).json(body);
}

/**
 * Guard: a valid host API key MUST be present. The catalog is global,
 * so we do not require any specific scope or tenant match \u2014 any
 * authenticated key is sufficient. A user Bearer token is NOT accepted;
 * this endpoint is service-to-service.
 */
function requireAnyHostKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.tenant) {
    sendError(
      res,
      401,
      'HOST_API_KEY_REQUIRED',
      'Host API key required'
    );
    return;
  }
  next();
}

/**
 * Compute a stable ETag for the catalog body. The same body always
 * produces the same ETag, so clients caching across deploys benefit
 * from 304 responses whenever nothing changed.
 *
 * Format: `W/"<catalogVersion>-<sha256-first-16-hex>"` (weak validator).
 */
export function computeCatalogEtag(body: string): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  return `W/"${CATALOG_VERSION}-${hash}"`;
}

/**
 * Parse the `If-None-Match` header (which may contain a comma-separated
 * list of tags) and return true iff any tag matches the current one.
 */
function ifNoneMatchHit(header: string | undefined, current: string): boolean {
  if (!header) return false;
  const tags = header.split(',').map((s) => s.trim());
  if (tags.includes('*')) return true;
  return tags.some((tag) => tag === current);
}

export function createHostWebhookEventsRouter(): Router {
  const router = Router();

  router.get(
    '/webhook-events',
    requireAnyHostKey,
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const payload = getEventCatalogResponse();
        const body = JSON.stringify(payload);
        const etag = computeCatalogEtag(body);

        res.setHeader('ETag', etag);
        // Catalog is identical for every host \u2014 safe to cache aggressively
        // at the edge. `public` allows shared caches; the long max-age is
        // safe because clients SHOULD revalidate via If-None-Match.
        res.setHeader(
          'Cache-Control',
          'public, max-age=300, stale-while-revalidate=600'
        );
        res.setHeader('Content-Type', 'application/json; charset=utf-8');

        if (ifNoneMatchHit(req.headers['if-none-match'], etag)) {
          res.status(304).end();
          return;
        }

        res.status(200).send(body);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
