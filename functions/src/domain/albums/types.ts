export interface Album {
  id: string;
  ownerId: string;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAlbumInput {
  ownerId: string;
  title: string;
  description?: string;
}
