import type {
  AddPhotoInput,
  ListPhotosInput,
  ListPhotosResult,
  Photo,
  UpdatePhotoInput,
} from "../../domain/library/types";

// ---------------------------------------------------------------------------
// Library API contracts
// ---------------------------------------------------------------------------

export type ListPhotosRequest = ListPhotosInput;
export type ListPhotosResponse = ListPhotosResult;

export type AddPhotoRequest = AddPhotoInput;
export interface AddPhotoResponse {
  photo: Photo;
}

export interface GetPhotoResponse {
  photo: Photo;
}

export type UpdatePhotoRequest = UpdatePhotoInput;
export interface UpdatePhotoResponse {
  photo: Photo;
}

export interface DeletePhotoRequest {
  photoId: string;
}