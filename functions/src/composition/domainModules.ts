import { InMemoryAlbumRepository } from '../adapters/domain/in-memory/InMemoryAlbumRepository.js';
import { InMemoryAuthProvider } from '../adapters/domain/in-memory/InMemoryAuthProvider.js';
import { InMemoryLibraryAccessPolicy } from '../adapters/domain/in-memory/InMemoryLibraryAccessPolicy.js';
import { InMemorySharePolicyRepository } from '../adapters/domain/in-memory/InMemorySharePolicyRepository.js';
import { AlbumsService } from '../domain/albums/AlbumsService.js';

export interface DomainModules {
  albums: AlbumsService;
  auth: InMemoryAuthProvider;
  library: InMemoryLibraryAccessPolicy;
  sharing: InMemorySharePolicyRepository;
}

export function createDomainModules(): DomainModules {
  const auth = new InMemoryAuthProvider({ userId: 'local-user-1', email: 'local@aurapix.local' });
  const albums = new AlbumsService(new InMemoryAlbumRepository());
  const library = new InMemoryLibraryAccessPolicy();
  const sharing = new InMemorySharePolicyRepository();

  return {
    albums,
    auth,
    library,
    sharing,
  };
}
