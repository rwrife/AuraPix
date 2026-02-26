import { InMemoryAlbumsService } from '../adapters/albums/inMemoryAlbumsService';
import { InMemoryAuthService } from '../adapters/auth/inMemoryAuthService';
import { InMemoryLibraryService } from '../adapters/library/inMemoryLibraryService';
import { InMemorySharingService } from '../adapters/sharing/inMemorySharingService';
import type { Services } from './ServiceContext';

// ---------------------------------------------------------------------------
// Factory for the local (single-user, no-Firebase) service bundle.
// Set VITE_SERVICE_MODE=local (or leave it unset) to use this bundle.
// ---------------------------------------------------------------------------

let _cached: Services | null = null;

export function createLocalServices(): Services {
  if (_cached) return _cached;

  _cached = {
    auth: new InMemoryAuthService(),
    albums: new InMemoryAlbumsService(),
    library: new InMemoryLibraryService(),
    sharing: new InMemorySharingService(),
  };

  return _cached;
}
