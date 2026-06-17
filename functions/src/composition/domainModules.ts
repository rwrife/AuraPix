import { InMemoryAlbumRepository } from '../adapters/domain/in-memory/InMemoryAlbumRepository.js';
import { InMemoryAuthProvider } from '../adapters/domain/in-memory/InMemoryAuthProvider.js';
import { InMemoryLibraryAccessPolicy } from '../adapters/domain/in-memory/InMemoryLibraryAccessPolicy.js';
import { InMemorySharePolicyRepository } from '../adapters/domain/in-memory/InMemorySharePolicyRepository.js';
import { InMemorySmartAlbumRepository } from '../adapters/domain/in-memory/InMemorySmartAlbumRepository.js';
import { AlbumsService } from '../domain/albums/AlbumsService.js';
import { SmartAlbumsService } from '../domain/smartAlbums/SmartAlbumsService.js';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';

export interface DomainModules {
  albums: AlbumsService;
  smartAlbums: SmartAlbumsService;
  smartAlbumRepository: InMemorySmartAlbumRepository;
  auth: InMemoryAuthProvider;
  library: InMemoryLibraryAccessPolicy;
  sharing: InMemorySharePolicyRepository;
}

export function createDomainModules(opts: { dataAdapter: DataAdapter }): DomainModules {
  const auth = new InMemoryAuthProvider({ userId: 'local-user-1', email: 'local@aurapix.local' });
  const albums = new AlbumsService(new InMemoryAlbumRepository());
  const smartAlbumRepository = new InMemorySmartAlbumRepository();
  const smartAlbums = new SmartAlbumsService({
    repo: smartAlbumRepository,
    dataAdapter: opts.dataAdapter,
  });
  const library = new InMemoryLibraryAccessPolicy();
  const sharing = new InMemorySharePolicyRepository();

  return {
    albums,
    smartAlbums,
    smartAlbumRepository,
    auth,
    library,
    sharing,
  };
}
