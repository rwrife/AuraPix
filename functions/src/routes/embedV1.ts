import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { recordAuditEvent } from '../services/audit/AuditService.js';
import { logger } from '../utils/logger.js';

/**
 * Embed handshake — issue #163.
 *
 * Per-tenant configuration for which origins are allowed to iframe AuraPix.
 *
 * The list is stored under the logical collection
 * `tenants_embed_config` keyed by tenantId (the conceptual Firestore path is
 * `tenants/{tenantId}/embedConfig`, flattened to fit the existing
 * DataAdapter API).
 *
 * Storing the empty list disables embedding for that tenant; this is the
 * default for new tenants, matching the issue requirement that "embed is
 * disabled by default".
 *
 * Each origin must be an exact match of scheme + host + (port when
 * non-default). Wildcards are intentionally NOT supported — the value is
 * inlined into the `Content-Security-Policy: frame-ancestors` header and
 * any leniency here directly relaxes click-jacking defenses for the host.
 */

export interface EmbedConfigRecord {
  tenantId: string;
  /** Allowed iframe ancestor origins (exact match scheme://host[:port]). */
  origins: string[];
  updatedAt: string;
}

export const EMBED_CONFIG_COLLECTION = 'tenants_embed_config';

const TENANT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validate that a value is a syntactically valid embed origin: an HTTPS (or
 * HTTP for localhost) absolute URL with no path, query, fragment, or
 * userinfo. Exported for unit testing.
 *
 * Returns the canonicalized origin string on success (e.g.
 * `https://app.example.com`, `http://localhost:3000`), or null otherwise.
 */
export function sanitizeOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 253 + 16) return null;

  // Reject anything that smells like header injection. `frame-ancestors` is
  // inlined into a response header so CR/LF/`;`/`'`/`"`/space MUST be
  // rejected.
  if (/[\s'";<>\\]/.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // Only http(s) — data:, file:, javascript:, etc. are never valid here.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  // http:// is only allowed for localhost / loopback (so dev hosts work but
  // we don't accidentally green-light cleartext production embedding).
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    const isLoopback =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.localhost');
    if (!isLoopback) return null;
  }

  // Must be an origin — no path beyond '/', no query, no fragment, no auth.
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '') {
    return null;
  }

  // Hostname required.
  if (!parsed.hostname) return null;

  return parsed.origin;
}

export const EmbedAllowedOriginsSchema = z.object({
  origins: z
    .array(z.string())
    .max(50)
    .refine(
      (arr) => arr.every((s) => sanitizeOrigin(s) !== null),
      { message: 'Each origin must be a valid scheme://host[:port] (https, or http for localhost)' }
    ),
});

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
  const payload: ApiErrorPayload = {
    error: { code, message, requestId: randomUUID(), details },
  };
  res.status(status).json(payload);
}

function isValidTenantId(value: string): boolean {
  return TENANT_ID_RE.test(value);
}

export function embedConfigWithDefaults(
  tenantId: string,
  partial: Partial<EmbedConfigRecord> | null
): EmbedConfigRecord {
  const origins = Array.isArray(partial?.origins) ? partial!.origins : [];
  // Dedupe + canonicalize on the way out so the response is stable even if
  // historical data contains slightly malformed entries.
  const canonical = Array.from(
    new Set(
      origins
        .map((o) => sanitizeOrigin(o))
        .filter((o): o is string => o !== null)
    )
  );
  return {
    tenantId,
    origins: canonical,
    updatedAt: partial?.updatedAt ?? new Date(0).toISOString(),
  };
}

export interface EmbedRouterOptions {
  /**
   * Authorization gate for PUT. Should return true when the caller has
   * `tenants.write` scope (host API key) or is the tenant owner. Defaults
   * to requiring an authenticated `req.user` (treated as owner) — in
   * production this is wired to the host-API-key middleware.
   */
  canWriteEmbedConfig?: (req: Request, tenantId: string) => boolean | Promise<boolean>;
}

export function createEmbedV1Router(
  dataAdapter: DataAdapter,
  options: EmbedRouterOptions = {}
): Router {
  const router = Router({ mergeParams: true });

  const canWrite =
    options.canWriteEmbedConfig ??
    ((req: Request) => Boolean(req.user));

  // Read — host backends typically read this during onboarding UIs. Same
  // auth requirement as write for now (host API key); a public read could
  // leak the host's customer topology.
  router.get('/:tenantId/embed/allowed-origins', async (req, res, next) => {
    try {
      const tenantId = req.params.tenantId;
      if (!isValidTenantId(tenantId)) {
        sendError(res, 400, 'INVALID_TENANT_ID', 'tenantId must match [a-zA-Z0-9_-]{1,64}');
        return;
      }
      const allowed = await canWrite(req, tenantId);
      if (!allowed) {
        sendError(res, 403, 'FORBIDDEN', 'tenants.write scope required to read embed configuration');
        return;
      }
      const stored = await dataAdapter.fetchData<EmbedConfigRecord>(EMBED_CONFIG_COLLECTION, tenantId);
      const record = embedConfigWithDefaults(tenantId, stored);
      res.status(200).json({ embed: { tenantId: record.tenantId, allowedOrigins: record.origins, updatedAt: record.updatedAt } });
    } catch (error) {
      next(error);
    }
  });

  // Write — host-API-key gated.
  router.put('/:tenantId/embed/allowed-origins', async (req, res, next) => {
    try {
      const tenantId = req.params.tenantId;
      if (!isValidTenantId(tenantId)) {
        sendError(res, 400, 'INVALID_TENANT_ID', 'tenantId must match [a-zA-Z0-9_-]{1,64}');
        return;
      }

      const allowed = await canWrite(req, tenantId);
      if (!allowed) {
        sendError(res, 403, 'FORBIDDEN', 'tenants.write scope required to update embed configuration');
        return;
      }

      const parsed = EmbedAllowedOriginsSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, 'INVALID_BODY', 'Invalid embed allowed-origins payload', {
          issues: parsed.error.issues,
        });
        return;
      }

      // Canonicalize + dedupe before persisting.
      const canonical = Array.from(
        new Set(
          parsed.data.origins
            .map((o) => sanitizeOrigin(o))
            .filter((o): o is string => o !== null)
        )
      );

      const now = new Date().toISOString();
      const record: EmbedConfigRecord = {
        tenantId,
        origins: canonical,
        updatedAt: now,
      };

      await dataAdapter.storeData<EmbedConfigRecord>(EMBED_CONFIG_COLLECTION, tenantId, record);

      try {
        await recordAuditEvent(dataAdapter, {
          eventType: 'embed.allowed_origins.updated',
          actorId: req.user?.uid ?? req.tenant?.keyId ?? 'host-api-key',
          targetId: tenantId,
          createdAt: now,
          metadata: {
            tenantId,
            originCount: canonical.length,
            embedDisabled: canonical.length === 0,
          },
        });
      } catch (auditErr) {
        logger.warn({ err: auditErr, tenantId }, 'Failed to record embed config audit event');
      }

      res.status(200).json({
        embed: {
          tenantId: record.tenantId,
          allowedOrigins: record.origins,
          updatedAt: record.updatedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  // CSP violation report endpoint — browsers POST here when a
  // `frame-ancestors` (or other) directive blocks rendering. We use it to
  // emit `embed.origin_blocked` so hosts can find misconfigured deployments.
  // Accepts both classic `application/csp-report` and Reporting API
  // `application/reports+json` bodies; the express.json() middleware should
  // be configured to accept those content types upstream, but we also tolerate
  // an already-parsed JSON body or a raw object.
  router.post('/:tenantId/embed/csp-report', (req, res, next) => {
    try {
      const tenantId = req.params.tenantId;
      if (!isValidTenantId(tenantId)) {
        // Don't fail the browser hard — just acknowledge and drop.
        res.status(204).end();
        return;
      }

      const body: any = req.body ?? {};
      const report =
        body?.['csp-report'] ??
        (Array.isArray(body) && body.length > 0 ? body[0]?.body : null) ??
        body;

      const violatedDirective: string =
        report?.['violated-directive'] || report?.violatedDirective || '';
      const blockedUri: string =
        report?.['blocked-uri'] || report?.blockedURL || '';
      const documentUri: string =
        report?.['document-uri'] || report?.documentURL || '';

      if (violatedDirective.startsWith('frame-ancestors')) {
        const meteringBus = (req.app.locals.meteringBus as
          | { emit?: (e: unknown) => void }
          | undefined);
        meteringBus?.emit?.({
          tenantId,
          type: 'embed.origin_blocked',
          meta: {
            blockedUri,
            documentUri,
            violatedDirective,
          },
        });
      }
      res.status(204).end();
    } catch (error) {
      // CSP reports should never break the response — log and ack.
      logger.debug({ err: error }, 'Failed to process CSP report');
      next(error);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// CSP middleware
// ---------------------------------------------------------------------------

export interface EmbedRouteContext {
  /** Tenant id derived from the request (path param, header, etc.). */
  tenantId: string | null;
}

/**
 * Build a middleware that, when a tenant context is available, sets
 * `Content-Security-Policy: frame-ancestors ...` and `X-Frame-Options`
 * headers on responses for embed-eligible routes.
 *
 * `tenantFromReq` extracts the tenant id from the request — typically a
 * path parameter (`/:tenantId/...`) or a header. When it returns null, the
 * middleware is a no-op so non-embed routes are not affected.
 *
 * `loadOrigins` fetches the persisted allowed-origins list for the tenant
 * and returns an array of canonical origins.
 *
 * When the allowed list is empty (embedding disabled), this emits
 * `frame-ancestors 'none'` + `X-Frame-Options: DENY` so browsers refuse to
 * frame the response.
 */
export function createEmbedCspMiddleware(opts: {
  tenantFromReq: (req: Request) => string | null;
  loadOrigins: (tenantId: string) => Promise<string[]>;
  /**
   * Optional `report-uri` template. When set, `;report-uri <uri>` is appended
   * to the CSP. `{tenantId}` is replaced with the resolved tenant id.
   */
  reportUriTemplate?: string;
  /**
   * Optional metering hook used to debounced-emit `embed.session_started`
   * events as host pages frame AuraPix. When omitted, no event is emitted.
   */
  meteringBus?: { emit?: (e: unknown) => void };
}) {
  // Per (tenantId, origin) dedupe window — see acceptance criteria
  // ("debounced, max 1/min/tenant/origin").
  const seen = new Map<string, number>();
  const DEDUPE_MS = 60_000;

  return async function embedCspMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const tenantId = opts.tenantFromReq(req);
      if (!tenantId) {
        next();
        return;
      }

      let origins: string[] = [];
      try {
        origins = await opts.loadOrigins(tenantId);
      } catch (err) {
        logger.warn({ err, tenantId }, 'Failed to load embed allowed-origins, defaulting to DENY');
      }

      let csp: string;
      if (origins.length === 0) {
        csp = "frame-ancestors 'none'";
        res.setHeader('X-Frame-Options', 'DENY');
      } else {
        csp = `frame-ancestors ${origins.join(' ')}`;
        // X-Frame-Options can only express ALLOW-FROM for a single origin and
        // most browsers ignore it. Use SAMEORIGIN when exactly one entry; CSP
        // is the source of truth for multi-origin lists.
        if (origins.length === 1) {
          res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        }
      }
      if (opts.reportUriTemplate) {
        const reportUri = opts.reportUriTemplate.replace('{tenantId}', encodeURIComponent(tenantId));
        csp = `${csp}; report-uri ${reportUri}`;
      }
      res.setHeader('Content-Security-Policy', csp);

      // Best-effort metering of embed sessions. Driven by the `Referer` /
      // `Sec-Fetch-Site=cross-site` headers — if the browser tells us this
      // is a cross-site framed request and the parent origin is allowed,
      // emit a debounced `embed.session_started` event.
      const referer = (req.headers.referer || req.headers.referrer) as
        | string
        | undefined;
      const secFetchDest = req.headers['sec-fetch-dest'];
      const isIframe = secFetchDest === 'iframe' || Boolean(referer);
      if (isIframe && origins.length > 0 && opts.meteringBus?.emit) {
        const parentOrigin = referer ? sanitizeOrigin(new URL(referer).origin) : null;
        if (parentOrigin && origins.includes(parentOrigin)) {
          const key = `${tenantId}|${parentOrigin}`;
          const now = Date.now();
          const last = seen.get(key) ?? 0;
          if (now - last >= DEDUPE_MS) {
            seen.set(key, now);
            // Tidy up the dedupe map occasionally so it doesn't grow
            // unbounded in long-lived processes.
            if (seen.size > 5000) {
              for (const [k, t] of seen) {
                if (now - t >= DEDUPE_MS * 5) seen.delete(k);
              }
            }
            try {
              opts.meteringBus.emit({
                tenantId,
                type: 'embed.session_started',
                meta: {
                  origin: parentOrigin,
                  userAgent: req.headers['user-agent'] ?? null,
                },
              });
            } catch (err) {
              logger.debug({ err, tenantId }, 'Failed to emit embed.session_started');
            }
          }
        }
      }

      next();
    } catch (err) {
      logger.warn({ err }, 'embedCspMiddleware failed open');
      next();
    }
  };
}

/**
 * Convenience helper to load the allowed origins for a tenant from the
 * data adapter, returning [] when no doc exists.
 */
export async function loadAllowedOriginsForTenant(
  dataAdapter: DataAdapter,
  tenantId: string
): Promise<string[]> {
  if (!isValidTenantId(tenantId)) return [];
  const stored = await dataAdapter.fetchData<EmbedConfigRecord>(
    EMBED_CONFIG_COLLECTION,
    tenantId
  );
  return embedConfigWithDefaults(tenantId, stored).origins;
}
