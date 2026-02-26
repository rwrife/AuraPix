import type {
  AddPhotoInput,
  BulkAddToAlbumInput,
  BulkAddToAlbumResult,
  ListPhotosInput,
  ListPhotosResult,
  Photo,
  UpdatePhotoInput,
} from './types';

export interface LibraryService {
  listPhotos(input: ListPhotosInput): Promise<ListPhotosResult>;
  getPhoto(photoId: string): Promise<Photo | null>;
  addPhoto(input: AddPhotoInput): Promise<Photo>;
  updatePhoto(photoId: string, input: UpdatePhotoInput): Promise<Photo>;
  deletePhoto(photoId: string): Promise<void>;
  bulkAddToAlbum(input: BulkAddToAlbumInput): Promise<BulkAddToAlbumResult>;
}
