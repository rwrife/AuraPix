import type { AlbumsService } from "../../domain/albums/contract";
import type {
  Album,
  AlbumFolder,
  CreateAlbumInput,
  CreateFolderInput,
} from "../../domain/albums/types";

const INITIAL_ALBUMS: Album[] = [
  {
    id: "album-seed-1",
    name: "Sample Highlights",
    folderId: null,
    createdAt: new Date("2026-01-15T12:00:00.000Z").toISOString(),
  },
];

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

export class InMemoryAlbumsService implements AlbumsService {
  private albums: Album[];
  private folders: AlbumFolder[];

  constructor(
    seedAlbums: Album[] = INITIAL_ALBUMS,
    seedFolders: AlbumFolder[] = [],
  ) {
    this.albums = [...seedAlbums];
    this.folders = [...seedFolders];
  }

  // ── Folders ────────────────────────────────────────────────────────────
  async listFolders(): Promise<AlbumFolder[]> {
    return [...this.folders].sort((a, b) => a.name.localeCompare(b.name));
  }

  async createFolder(input: CreateFolderInput): Promise<AlbumFolder> {
    const name = input.name.trim();
    if (!name) throw new Error("Folder name is required.");
    const folder: AlbumFolder = {
      id: uid("folder"),
      name,
      createdAt: new Date().toISOString(),
    };
    this.folders = [folder, ...this.folders];
    return folder;
  }

  async deleteFolder(folderId: string): Promise<void> {
    this.folders = this.folders.filter((f) => f.id !== folderId);
    // Un-fold albums that were in this folder
    this.albums = this.albums.map((a) =>
      a.folderId === folderId ? { ...a, folderId: null } : a,
    );
  }

  // ── Albums ─────────────────────────────────────────────────────────────
  async listAlbums(): Promise<Album[]> {
    return [...this.albums].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async getAlbum(albumId: string): Promise<Album | null> {
    return this.albums.find((a) => a.id === albumId) ?? null;
  }

  async createAlbum(input: CreateAlbumInput): Promise<Album> {
    const name = input.name.trim();
    if (!name) throw new Error("Album name is required.");
    const album: Album = {
      id: uid("album"),
      name,
      folderId: input.folderId ?? null,
      createdAt: new Date().toISOString(),
    };
    this.albums = [album, ...this.albums];
    return album;
  }

  async updateAlbum(
    albumId: string,
    updates: Partial<Pick<Album, "folderId">>,
  ): Promise<Album> {
    const idx = this.albums.findIndex((a) => a.id === albumId);
    if (idx === -1) throw new Error("Album not found.");
    const updated: Album = { ...this.albums[idx], ...updates };
    this.albums = this.albums.map((a) => (a.id === albumId ? updated : a));
    return updated;
  }

  async deleteAlbum(albumId: string): Promise<void> {
    this.albums = this.albums.filter((a) => a.id !== albumId);
  }
}