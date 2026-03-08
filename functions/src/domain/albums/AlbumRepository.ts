import type { Album, CreateAlbumInput } from './types.js';

export interface AlbumRepository {
  listByOwner(ownerId: string): Promise<Album[]>;
  create(input: CreateAlbumInput): Promise<Album>;
}
