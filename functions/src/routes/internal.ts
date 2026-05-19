import { Router } from 'express';
import type { Request, Response } from 'express';
import type { StorageAdapter } from '../adapters/storage/StorageAdapter.js';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { generateThumbnailsForPhoto } from '../handlers/thumbnails/generate.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { buildStorageUsageReport } from '../handlers/storage/usageReport.js';
import {
  createTenantApiKey,
  listTenantApiKeys,
  redactTenantApiKey,
  revokeTenantApiKey,
  validateScopes,
} from '../services/host/tenantApiKeyService.js';
import { requireUserOrTenantScopes } from '../middleware/hostApiKeyAuth.js';
import { isAdminUser } from '../config/index.js';

const router = Router();

/**
 * Admin-only guard. Allows requests from a user on the ADMIN_USER_IDS
 * allowlist. Host API keys can never use these endpoints (managing keys is
 * a privileged user-only action).
 */
function requireAdmin(req: Request, res: Response, next: () => void): void {
  if (req.tenant) {
    res.status(403).json({ error: 'Admin endpoints are not accessible via host API keys' });
    return;
  }
  if (!isAdminUser(req.user)) {
    res.status(403).json({ error: 'Admin privileges required' });
    return;
  }
  next();
}

/**
 * Health check endpoint
 * GET /internal/health
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'aurapix-backend',
    version: '1.0.0',
  });
});

/**
 * Tenant API key management (admin-only). Plaintext secret is returned
 * exactly once on creation; only the SHA-256 hash is stored.
 */
router.post(
  '/tenants/:tenantId/api-keys',
  requireAdmin,
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = req.params.tenantId as string;
      const dataAdapter = req.app.locals.dataAdapter as DataAdapter;
      const body = (req.body || {}) as { scopes?: unknown; label?: unknown };
      let scopes;
      try {
        scopes = validateScopes(body.scopes);
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Invalid scopes',
        });
        return;
      }
      const label = typeof body.label === 'string' ? body.label : undefined;
      const created = await createTenantApiKey(dataAdapter, { tenantId, scopes, label });
      res.status(201).json({
        key: redactTenantApiKey(created.record),
        // Show plaintext exactly once. The client MUST persist it now.
        secret: created.plaintextSecret,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create tenant API key');
      next(
        new AppError(
          500,
          'TENANT_API_KEY_CREATE_FAILED',
          error instanceof Error ? error.message : 'Failed to create tenant API key'
        )
      );
    }
  }
);

router.get(
  '/tenants/:tenantId/api-keys',
  requireAdmin,
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = req.params.tenantId as string;
      const dataAdapter = req.app.locals.dataAdapter as DataAdapter;
      const keys = await listTenantApiKeys(dataAdapter, tenantId);
      res.json({ keys: keys.map(redactTenantApiKey) });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list tenant API keys');
      next(
        new AppError(
          500,
          'TENANT_API_KEY_LIST_FAILED',
          error instanceof Error ? error.message : 'Failed to list tenant API keys'
        )
      );
    }
  }
);

router.delete(
  '/tenants/:tenantId/api-keys/:keyId',
  requireAdmin,
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = req.params.tenantId as string;
      const keyId = req.params.keyId as string;
      const dataAdapter = req.app.locals.dataAdapter as DataAdapter;
      const revoked = await revokeTenantApiKey(dataAdapter, tenantId, keyId);
      if (!revoked) {
        res.status(404).json({ error: 'Key not found' });
        return;
      }
      res.json({ key: redactTenantApiKey(revoked) });
    } catch (error) {
      logger.error({ err: error }, 'Failed to revoke tenant API key');
      next(
        new AppError(
          500,
          'TENANT_API_KEY_REVOKE_FAILED',
          error instanceof Error ? error.message : 'Failed to revoke tenant API key'
        )
      );
    }
  }
);

/**
 * Report library storage usage totals and photo-level breakdown.
 *
 * Accepts EITHER:
 *  - an authenticated admin user, OR
 *  - a host API key carrying the `usage.read` scope (and matching the tenant
 *    that owns the library, if a `tenantId` query param is provided).
 *
 * GET /internal/storage-usage/:libraryId
 */
router.get(
  '/storage-usage/:libraryId',
  requireUserOrTenantScopes({
    scopes: ['usage.read'],
    tenantIdFromReq: (req) =>
      typeof req.query.tenantId === 'string' ? (req.query.tenantId as string) : undefined,
  }),
  async (req: Request, res: Response, next) => {
    try {
      const libraryId = req.params.libraryId as string;
      const storageAdapter = req.app.locals.storageAdapter as StorageAdapter;

      const report = await buildStorageUsageReport(storageAdapter, libraryId);
      res.json(report);
    } catch (error) {
      logger.error({ err: error }, 'Storage usage report failed');
      next(
        new AppError(
          500,
          'STORAGE_USAGE_REPORT_FAILED',
          error instanceof Error ? error.message : 'Storage usage report failed'
        )
      );
    }
  }
);

/**
 * Manually trigger thumbnail generation
 * POST /internal/generate-thumbnails/:libraryId/:photoId
 */
router.post(
  '/generate-thumbnails/:libraryId/:photoId',
  (req, res, next) => {
    // Preserve existing behavior: thumbnail generation requires a logged-in
    // user. Host API keys cannot trigger generation.
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  },
  async (req: Request, res: Response, next) => {
    try {
      const libraryId = req.params.libraryId as string;
      const photoId = req.params.photoId as string;
      const storageAdapter = req.app.locals.storageAdapter as StorageAdapter;
      const dataAdapter = req.app.locals.dataAdapter as DataAdapter;

      logger.info({ libraryId, photoId }, 'Manual thumbnail generation requested');

      await generateThumbnailsForPhoto(
        photoId,
        libraryId,
        storageAdapter,
        dataAdapter
      );

      res.json({
        message: 'Thumbnails generated successfully',
        photoId,
        libraryId,
      });
    } catch (error) {
      logger.error({ err: error }, 'Thumbnail generation failed');
      next(
        new AppError(
          500,
          'THUMBNAIL_GENERATION_FAILED',
          error instanceof Error ? error.message : 'Thumbnail generation failed'
        )
      );
    }
  }
);

export default router;
