import { Router } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { createBulkPhotosHandler } from '../handlers/photos/batch.js';
import type { TenantId } from '../domain/tenant/Tenant.js';

/**
 * Bulk photo operations endpoint introduced in issue #142.
 *
 * Mounted at `/api/v1/photos:batch` (single resource path, not nested
 * under `/photos`), matching the issue spec.
 */
export function createBulkPhotosRouter(
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
