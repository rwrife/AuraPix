import { describe, expect, it } from 'vitest';
import { InMemoryAlbumRepository } from '../../adapters/domain/in-memory/InMemoryAlbumRepository.js';
import { AlbumsService } from './AlbumsService.js';

describe('AlbumsService remove', () => {
  it('deletes an owned album', async () => {
    const service = new AlbumsService(new InMemoryAlbumRepository());
    const ownerId = 'user-1';

    const created = await service.create({
      ownerId,
      title: 'Trip',
      description: 'photo set',
    });

    await service.remove(ownerId, created.id);

    await expect(service.list(ownerId)).resolves.toEqual([]);
  });

  it('throws when album does not exist', async () => {
    const service = new AlbumsService(new InMemoryAlbumRepository());

    await expect(service.remove('user-1', 'missing')).rejects.toThrowError('album-not-found');
  });

  it('treats cross-owner album deletion as not found', async () => {
    const service = new AlbumsService(new InMemoryAlbumRepository());
    const ownerAlbum = await service.create({ ownerId: 'owner', title: 'Owner album' });
    const otherAlbum = await service.create({ ownerId: 'other', title: 'Other album' });

    await expect(service.remove('owner', otherAlbum.id)).rejects.toThrowError('album-not-found');

    await expect(service.list('owner')).resolves.toEqual([ownerAlbum]);
    await expect(service.list('other')).resolves.toEqual([otherAlbum]);
  });
});
