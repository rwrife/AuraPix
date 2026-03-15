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

  async updateTitle(ownerId: string, albumId: string, title: string): Promise<Album | null> {
    const existing = this.albums.get(ownerId) ?? [];
    const index = existing.findIndex((album) => album.id === albumId);
    if (index === -1) {
      return null;
    }

    const album = existing[index]!;
    const updated: Album = {
      ...album,
      title,
      updatedAt: new Date().toISOString(),
    };

    const next = [...existing];
    next[index] = updated;
    this.albums.set(ownerId, next);

    return updated;
  }

  async delete(ownerId: string, albumId: string): Promise<boolean> {
    const existing = this.albums.get(ownerId) ?? [];
    const next = existing.filter((album) => album.id !== albumId);
    if (next.length === existing.length) {
      return false;
    }

    this.albums.set(ownerId, next);
    return true;
  }
}
