import { randomUUID } from 'node:crypto';
import type { AlbumRepository } from './AlbumRepository.js';
import type { Album, CreateAlbumInput } from './types.js';

export class AlbumsService {
  constructor(private readonly albums: AlbumRepository) {}

  async list(ownerId: string): Promise<Album[]> {
    return this.albums.listByOwner(ownerId);
  }

  async create(input: CreateAlbumInput): Promise<Album> {
    const title = input.title.trim();
    if (!title) {
      throw new Error('album-title-required');
    }

    return this.albums.create({
      ...input,
      title,
    });
  }

  static createAlbumRecord(input: CreateAlbumInput): Album {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      ownerId: input.ownerId,
      title: input.title,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    };
  }
}
