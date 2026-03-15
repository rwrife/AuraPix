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
});
