import { AlbumsService } from '../../../domain/albums/AlbumsService.js';
import type { AlbumRepository } from '../../../domain/albums/AlbumRepository.js';
import type { Album, CreateAlbumInput } from '../../../domain/albums/types.js';

export class InMemoryAlbumRepository implements AlbumRepository {
  private readonly albums = new Map<string, Album[]>();

  async listByOwner(ownerId: string): Promise<Album[]> {
    return [...(this.albums.get(ownerId) ?? [])].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
  }

  async create(input: CreateAlbumInput): Promise<Album> {
    const record = AlbumsService.createAlbumRecord(input);
    const existing = this.albums.get(input.ownerId) ?? [];
    this.albums.set(input.ownerId, [...existing, record]);
    return record;
  }
}
