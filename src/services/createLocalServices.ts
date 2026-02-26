import { InMemoryAlbumsService } from '../adapters/albums/inMemoryAlbumsService';
import { InMemoryAuthService } from '../adapters/auth/inMemoryAuthService';
import { InMemoryLibraryService } from '../adapters/library/inMemoryLibraryService';
import { InMemorySharingService } from '../adapters/sharing/inMemorySharingService';
import { InMemoryUploadSessionsService } from '../adapters/uploads/inMemoryUploadSessionsService';
import type { Services } from './ServiceContext';

// ---------------------------------------------------------------------------
// Factory for the local (single-user, no-Firebase) service bundle.
// Set VITE_SERVICE_MODE=local (or leave it unset) to use this bundle.
// ---------------------------------------------------------------------------

let _cached: Services | null = null;

function resolveLocalLibraryQuota(): number | undefined {
  const raw = import.meta.env.VITE_LOCAL_LIBRARY_QUOTA_BYTES;
  if (!raw) return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.floor(parsed);
}

export function createLocalServices(): Services {
  if (_cached) return _cached;

  const localLibraryQuotaBytes = resolveLocalLibraryQuota();

  _cached = {
    auth: new InMemoryAuthService(),
    albums: new InMemoryAlbumsService(),
    library: new InMemoryLibraryService({
      quotaBytesByLibraryId: localLibraryQuotaBytes
        ? {
            'library-local-user-1': localLibraryQuotaBytes,
          }
        : undefined,
    }),
    sharing: new InMemorySharingService(),
    uploads: new InMemoryUploadSessionsService(),
  };

  return _cached;
}
