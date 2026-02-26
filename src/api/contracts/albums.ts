import type { Album, CreateAlbumInput } from '../../domain/albums/types';

// ---------------------------------------------------------------------------
// Albums API contracts
// ---------------------------------------------------------------------------

export type CreateAlbumRequest = CreateAlbumInput;
export interface CreateAlbumResponse {
  album: Album;
}

export interface ListAlbumsResponse {
  albums: Album[];
}

export interface GetAlbumResponse {
  album: Album;
}

export interface DeleteAlbumRequest {
  albumId: string;
}
