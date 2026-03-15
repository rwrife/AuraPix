import type { Album, CreateAlbumInput } from './types.js';

export interface AlbumRepository {
  listByOwner(ownerId: string): Promise<Album[]>;
  create(input: CreateAlbumInput): Promise<Album>;
  updateTitle(ownerId: string, albumId: string, title: string): Promise<Album | null>;
  delete(ownerId: string, albumId: string): Promise<boolean>;
}
