import type { Album, CreateAlbumInput } from './types';

export interface AlbumsService {
  listAlbums(): Promise<Album[]>;
  createAlbum(input: CreateAlbumInput): Promise<Album>;
}
