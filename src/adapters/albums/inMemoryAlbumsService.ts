import type { AlbumsService } from '../../domain/albums/contract';
import type { Album, CreateAlbumInput } from '../../domain/albums/types';

const INITIAL_ALBUMS: Album[] = [
  {
    id: 'album-seed-1',
    name: 'Sample Highlights',
    createdAt: new Date('2026-01-15T12:00:00.000Z').toISOString(),
  },
];

export class InMemoryAlbumsService implements AlbumsService {
  private albums: Album[];

  constructor(seed: Album[] = INITIAL_ALBUMS) {
    this.albums = [...seed];
  }

  async listAlbums(): Promise<Album[]> {
    return [...this.albums].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createAlbum(input: CreateAlbumInput): Promise<Album> {
    const normalizedName = input.name.trim();

    if (!normalizedName) {
      throw new Error('Album name is required.');
    }

    const album: Album = {
      id: `album-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name: normalizedName,
      createdAt: new Date().toISOString(),
    };

    this.albums = [album, ...this.albums];
    return album;
  }
}
