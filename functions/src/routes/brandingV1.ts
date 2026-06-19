import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { recordAuditEvent } from '../services/audit/AuditService.js';
import { getEffectiveFeatureFlags } from '../services/host/tenantFeaturesConfigService.js';
import { logger } from '../utils/logger.js';

/**
 * Per-tenant branding/theme configuration.
 *
 * Stored under the logical collection `tenants_branding` keyed by tenantId
 * (the conceptual Firestore path is `tenants/{tenantId}/branding`, flattened
 * to fit the existing DataAdapter API).
 */
export interface BrandingRecord {
  tenantId: string;
  appName: string;
  primaryColor: string;
  accentColor: string;
  logoUrl?: string;
  faviconUrl?: string;
  updatedAt: string;
}

export const BRANDING_COLLECTION = 'tenants_branding';

export const DEFAULT_BRANDING: Omit<BrandingRecord, 'tenantId' | 'updatedAt'> = {
  appName: 'AuraPix',
  primaryColor: '#2563eb',
  accentColor: '#7c3aed',
};

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const TENANT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validate a CSS hex color. Accepts #RGB or #RRGGBB. Rejects everything else
 * (named colors, rgb(), rgba(), hsl(), arbitrary strings, attempts to inject
 * CSS via `}` etc.). Exported for unit tests.
 */
export function sanitizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_RE.test(trimmed)) return null;
  return trimmed;
}

const UrlSchema = z.string().url().max(2048);

export const BrandingUpdateSchema = z.object({
  appName: z.string().min(1).max(64),
  primaryColor: z
    .string()
    .refine((v) => sanitizeHexColor(v) !== null, { message: 'primaryColor must be a hex color like #RRGGBB' }),
  accentColor: z
    .string()
    .refine((v) => sanitizeHexColor(v) !== null, { message: 'accentColor must be a hex color like #RRGGBB' }),
  logoUrl: UrlSchema.optional(),
  faviconUrl: UrlSchema.optional(),
});

export type BrandingUpdateInput = z.infer<typeof BrandingUpdateSchema>;

interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: Record<string, unknown> | null;
  };
}

function sendError(
  res: { status: (code: number) => { json: (payload: ApiErrorPayload) => void } },
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> | null = null
): void {
  res.status(status).json({
    error: { code, message, requestId: randomUUID(), details },
  });
}

function isValidTenantId(value: string): boolean {
  return TENANT_ID_RE.test(value);
}

export function brandingWithDefaults(tenantId: string, partial: Partial<BrandingRecord> | null): BrandingRecord {
  return {
    tenantId,
    appName: partial?.appName ?? DEFAULT_BRANDING.appName,
    primaryColor: partial?.primaryColor ?? DEFAULT_BRANDING.primaryColor,
    accentColor: partial?.accentColor ?? DEFAULT_BRANDING.accentColor,
    logoUrl: partial?.logoUrl,
    faviconUrl: partial?.faviconUrl,
    updatedAt: partial?.updatedAt ?? new Date(0).toISOString(),
  };
}

export interface BrandingRouterOptions {
  /**
   * Authorization gate for PUT. Should return true when the caller has
   * `tenants.write` scope (host API key) or is the tenant owner.
   * Defaults to requiring an authenticated `req.user` (treated as owner).
   */
  canWriteBranding?: (req: import('express').Request, tenantId: string) => boolean | Promise<boolean>;
}

export function createBrandingV1Router(
  dataAdapter: DataAdapter,
  options: BrandingRouterOptions = {}
): Router {
  const router = Router({ mergeParams: true });

  const canWrite =
    options.canWriteBranding ??
    ((req) => Boolean(req.user));

  // Public read — no auth required (branding is public-facing).
  router.get('/:tenantId/branding', async (req, res, next) => {
    try {
      const tenantId = req.params.tenantId;
      if (!isValidTenantId(tenantId)) {
        sendError(res, 400, 'INVALID_TENANT_ID', 'tenantId must match [a-zA-Z0-9_-]{1,64}');
        return;
      }

      const stored = await dataAdapter.fetchData<BrandingRecord>(BRANDING_COLLECTION, tenantId);
      const branding = brandingWithDefaults(tenantId, stored);

      // Per-tenant feature flags (issue #175) are surfaced in the same
      // bootstrap payload so the embedded UI can hide disabled affordances
      // (avoids dead buttons) without a second request. Defaults all-on so
      // tenants with no doc behave as before.
      let features;
      try {
        features = await getEffectiveFeatureFlags(dataAdapter, tenantId);
      } catch (err) {
        logger.warn(
          { err, tenantId },
          'Failed to resolve feature flags for branding bootstrap; falling back to defaults'
        );
        // Don't fail the branding response on a feature lookup miss — the
        // UI degrades gracefully to all-on, matching the server-side default.
        features = undefined;
      }

      // Cacheable: branding rarely changes and is public. Features change
      // more often, but the 60s freshness window is acceptable and bounded
      // by the service-layer TTL anyway.
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      res.status(200).json(features ? { branding, features } : { branding });
    } catch (error) {
      next(error);
    }
  });

  // Admin-gated write.
  router.put('/:tenantId/branding', async (req, res, next) => {
    try {
      const tenantId = req.params.tenantId;
      if (!isValidTenantId(tenantId)) {
        sendError(res, 400, 'INVALID_TENANT_ID', 'tenantId must match [a-zA-Z0-9_-]{1,64}');
        return;
      }

      const allowed = await canWrite(req, tenantId);
      if (!allowed) {
        sendError(res, 403, 'FORBIDDEN', 'tenants.write scope required to update branding');
        return;
      }

      const parsed = BrandingUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, 'INVALID_BODY', 'Invalid branding payload', {
          issues: parsed.error.issues,
        });
        return;
      }

      const now = new Date().toISOString();
      const record: BrandingRecord = {
        tenantId,
        appName: parsed.data.appName,
        primaryColor: sanitizeHexColor(parsed.data.primaryColor)!,
        accentColor: sanitizeHexColor(parsed.data.accentColor)!,
        logoUrl: parsed.data.logoUrl,
        faviconUrl: parsed.data.faviconUrl,
        updatedAt: now,
      };

      await dataAdapter.storeData<BrandingRecord>(BRANDING_COLLECTION, tenantId, record);

      // Emit metering / audit event for compliance trails.
      try {
        await recordAuditEvent(dataAdapter, {
          eventType: 'metering.branding.updated',
          actorId: req.user?.uid ?? 'host-api-key',
          targetId: tenantId,
          createdAt: now,
          metadata: {
            tenantId,
            appName: record.appName,
            hasLogo: Boolean(record.logoUrl),
            hasFavicon: Boolean(record.faviconUrl),
          },
        });
      } catch (auditErr) {
        // Audit failures should not break the write.
        logger.warn({ err: auditErr, tenantId }, 'Failed to record branding audit event');
      }

      res.status(200).json({ branding: record });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
