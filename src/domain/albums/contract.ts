import type { Album, AlbumFolder, CreateAlbumInput, CreateFolderInput } from './types';

export interface AlbumsService {
  // Folders (one level deep)
  listFolders(): Promise<AlbumFolder[]>;
  createFolder(input: CreateFolderInput): Promise<AlbumFolder>;
  updateFolder(folderId: string, updates: Partial<Pick<AlbumFolder, 'name'>>): Promise<AlbumFolder>;
  deleteFolder(folderId: string): Promise<void>;

  // Albums
  listAlbums(): Promise<Album[]>;
  getAlbum(albumId: string): Promise<Album | null>;
  createAlbum(input: CreateAlbumInput): Promise<Album>;
  updateAlbum(albumId: string, updates: Partial<Pick<Album, 'name' | 'folderId'>>): Promise<Album>;
  deleteAlbum(albumId: string): Promise<void>;
}
