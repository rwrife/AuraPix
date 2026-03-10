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

  it('renames an album for the owner', async () => {
    const service = new AlbumsService(new InMemoryAlbumRepository());
    const created = await service.create({ ownerId: 'u1', title: 'Roadtrip' });

    const renamed = await service.rename('u1', created.id, 'Summer Roadtrip');

    expect(renamed.title).toBe('Summer Roadtrip');
    expect(renamed.updatedAt >= created.updatedAt).toBe(true);

    const listed = await service.list('u1');
    expect(listed[0]?.title).toBe('Summer Roadtrip');
  });

  it('rejects album creation when title is blank', async () => {
    const service = new AlbumsService(new InMemoryAlbumRepository());

    await expect(
      service.create({ ownerId: 'u1', title: '   ' })
    ).rejects.toThrow('album-title-required');
  });

  it('rejects rename when album is missing', async () => {
    const service = new AlbumsService(new InMemoryAlbumRepository());

    await expect(service.rename('u1', 'missing', 'New name')).rejects.toThrow('album-not-found');
  });
});
