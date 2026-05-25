import { Router } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { createBulkPhotosHandler } from '../handlers/photos/batch.js';
import type { TenantId } from '../domain/tenant/Tenant.js';

/**
 * Versioned photos router. Currently exposes only the bulk operations
 * endpoint introduced in issue #142.
 *
 * NOTE: We mount this at `/api/v1/photos:batch` rather than
 * `/api/v1/photos/batch` to match the issue spec exactly.
 */
export function createPhotosV1Router(
  dataAdapter: DataAdapter,
  opts?: { tenantOfPhoto?: (photoId: string) => Promise<TenantId | null> }
): Router {
  const router = Router({ mergeParams: true });
  const handler = createBulkPhotosHandler({
    dataAdapter,
    tenantOfPhoto: opts?.tenantOfPhoto,
  });
  router.post('/', handler);
  return router;
}
