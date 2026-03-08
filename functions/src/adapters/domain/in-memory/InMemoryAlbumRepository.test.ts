import { describe, expect, it } from 'vitest';
import { InMemoryAlbumRepository } from './InMemoryAlbumRepository.js';
import { AlbumsService } from '../../../domain/albums/AlbumsService.js';

describe('InMemoryAlbumRepository', () => {
  it('creates and lists albums scoped by owner', async () => {
    const service = new AlbumsService(new InMemoryAlbumRepository());

    await service.create({ ownerId: 'u1', title: 'Roadtrip' });
    await service.create({ ownerId: 'u2', title: 'Work' });

    const user1Albums = await service.list('u1');
    const user2Albums = await service.list('u2');

    expect(user1Albums).toHaveLength(1);
    expect(user1Albums[0]?.title).toBe('Roadtrip');
    expect(user2Albums).toHaveLength(1);
    expect(user2Albums[0]?.title).toBe('Work');
  });

  it('rejects album creation when title is blank', async () => {
    const service = new AlbumsService(new InMemoryAlbumRepository());

    await expect(
      service.create({ ownerId: 'u1', title: '   ' })
    ).rejects.toThrow('album-title-required');
  });
});
