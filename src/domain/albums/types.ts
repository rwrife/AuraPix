export interface AlbumFolder {
  id: string;
  name: string;
  createdAt: string;
}

export interface Album {
  id: string;
  name: string;
  folderId?: string | null;
  createdAt: string;
}

export interface CreateAlbumInput {
  name: string;
  folderId?: string | null;
}

export interface CreateFolderInput {
  name: string;
}