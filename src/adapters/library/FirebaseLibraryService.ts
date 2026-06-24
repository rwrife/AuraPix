import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit as firestoreLimit,
  startAfter,
  type Firestore,
  type QueryConstraint,
  type DocumentSnapshot,
} from 'firebase/firestore';
import {
  ref,
  uploadString,
  deleteObject,
  type FirebaseStorage,
} from 'firebase/storage';
import type { LibraryService } from '../../domain/library/contract';
import {
  isPhotoColorLabel,
  isPhotoFlag,
  isPhotoRating,
  PHOTO_COLOR_LABEL_VALUES,
  type AddPhotoInput,
  type BulkAddToAlbumInput,
  type BulkAddToAlbumResult,
  type LibraryUsageSummary,
  type ListPhotosInput,
  type ListPhotosResult,
  type LibrarySort,
  type Photo,
  type UpdatePhotoInput,
} from '../../domain/library/types';
import { COLLECTIONS } from '../../config/collections';
import { generatePhotoStoragePath, getThumbnailPath } from '../../utils/storage-paths';
import type { OperationAuthorizer } from '../../domain/authorization/contract';

/**
 * Firebase implementation of LibraryService.
 * This adapter supports optional authorization callbacks for quota management.
 */
export class FirebaseLibraryService implements LibraryService {
  private db: Firestore;
  private storage: FirebaseStorage;
  private authorizer?: OperationAuthorizer;

  constructor(
    db: Firestore,
    storage: FirebaseStorage,
    authorizer?: OperationAuthorizer
  ) {
    this.db = db;
    this.storage = storage;
    this.authorizer = authorizer;
  }

  private toCreatedAtDirection(sort?: LibrarySort): 'asc' | 'desc' {
    return sort === 'created_asc' ? 'asc' : 'desc';
  }

  private applyClientSort(photos: Photo[], sort?: LibrarySort): Photo[] {
    if (sort === 'name_asc') {
      return [...photos].sort((a, b) => a.originalName.localeCompare(b.originalName));
    }

    if (sort === 'name_desc') {
      return [...photos].sort((a, b) => b.originalName.localeCompare(a.originalName));
    }

    return photos;
  }

  async listPhotos(input: ListPhotosInput): Promise<ListPhotosResult> {
    const photosRef = collection(this.db, COLLECTIONS.PHOTOS);
    const constraints: QueryConstraint[] = [
      where('libraryId', '==', input.libraryId),
      orderBy('createdAt', this.toCreatedAtDirection(input.sort)),
    ];

    // Filter by album
    if (input.albumId) {
      constraints.push(where('albumIds', 'array-contains', input.albumId));
    }

    // Filter by favorites (backward compatible with favoritesOnly flag)
    if (input.favoritesOnly || input.collection === 'favorites') {
      constraints.push(where('isFavorite', '==', true));
    }

    // Filter by tags
    if (input.tags && input.tags.length > 0) {
      constraints.push(where('tags', 'array-contains-any', input.tags));
    }

    // Filter by minimum rating (composite index: tenantId/libraryId, rating)
    if (input.minRating !== undefined) {
      if (!isPhotoRating(input.minRating)) {
        throw new Error(`Invalid minRating: ${String(input.minRating)} (expected integer 0–5).`);
      }
      constraints.push(where('rating', '>=', input.minRating));
    }

    // Filter by triage flag (composite index: tenantId/libraryId, flag)
    if (input.flag !== undefined) {
      if (input.flag === 'unflagged') {
        constraints.push(where('flag', '==', null));
      } else {
        if (!isPhotoFlag(input.flag)) {
          throw new Error(`Invalid flag: ${String(input.flag)}.`);
        }
        constraints.push(where('flag', '==', input.flag));
      }
    }

    // Filter by color label (composite index: tenantId/libraryId, colorLabel) — issue #184
    if (input.colorLabel !== undefined) {
      if (Array.isArray(input.colorLabel)) {
        if (input.colorLabel.length === 0) {
          throw new Error('Invalid colorLabel filter: empty array.');
        }
        for (const value of input.colorLabel) {
          if (!isPhotoColorLabel(value) || value === null) {
            throw new Error(
              `Invalid colorLabel filter value: ${String(value)} (expected one of ${PHOTO_COLOR_LABEL_VALUES.join(
                ', '
              )}).`
            );
          }
        }
        constraints.push(where('colorLabel', 'in', input.colorLabel));
      } else if (input.colorLabel === 'uncolored') {
        constraints.push(where('colorLabel', '==', null));
      } else {
        if (!isPhotoColorLabel(input.colorLabel)) {
          throw new Error(`Invalid colorLabel: ${String(input.colorLabel)}.`);
        }
        constraints.push(where('colorLabel', '==', input.colorLabel));
      }
    }

    // Apply pagination
    const pageSize = input.pageSize || 50;
    constraints.push(firestoreLimit(pageSize + 1)); // Fetch one extra to determine if there are more

    // If pageToken provided, start after that document
    if (input.pageToken) {
      const lastDocSnap = await getDoc(doc(this.db, COLLECTIONS.PHOTOS, input.pageToken));
      if (lastDocSnap.exists()) {
        constraints.push(startAfter(lastDocSnap));
      }
    }

    const q = query(photosRef, ...constraints);
    const snapshot = await getDocs(q);

    const photos: Photo[] = [];
    let nextPageToken: string | null = null;

    snapshot.docs.forEach((docSnap, index) => {
      // If we got more than pageSize, use the last one as nextPageToken
      if (index === pageSize) {
        nextPageToken = docSnap.id;
      } else {
        photos.push(this.mapDocToPhoto(docSnap));
      }
    });

    return { photos: this.applyClientSort(photos, input.sort), nextPageToken };
  }

  async getUsage(libraryId: string): Promise<LibraryUsageSummary> {
    const photosRef = collection(this.db, COLLECTIONS.PHOTOS);
    const snapshot = await getDocs(query(photosRef, where('libraryId', '==', libraryId)));
    const photos = snapshot.docs.map((docSnap) => this.mapDocToPhoto(docSnap));

    return {
      libraryId,
      totalPhotos: photos.length,
      readyPhotos: photos.filter((photo) => photo.status === 'ready').length,
      favoritePhotos: photos.filter((photo) => photo.isFavorite).length,
      taggedPhotos: photos.filter((photo) => photo.tags.length > 0).length,
      totalBytes: photos.reduce((total, photo) => total + (photo.metadata?.sizeBytes ?? 0), 0),
    };
  }

  async getPhoto(photoId: string): Promise<Photo | null> {
    const docRef = doc(this.db, COLLECTIONS.PHOTOS, photoId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      return null;
    }

    return this.mapDocToPhoto(docSnap);
  }

  async addPhoto(input: AddPhotoInput): Promise<Photo> {
    // Extract user ID from library ID (format: library-{userId})
    const userId = input.libraryId.replace('library-', '');

    // Convert data URL to blob to get accurate file size
    const file = await this.dataUrlToFile(input.dataUrl, input.originalName);

    // Call authorization service if provided
    if (this.authorizer?.authorizeUpload) {
      const authResult = await this.authorizer.authorizeUpload({
        userId,
        albumId: null,
        fileSizeBytes: file.size,
        fileName: input.originalName,
        mimeType: input.metadata?.mimeType || file.type,
      });

      if (!authResult.authorized) {
        throw new Error(authResult.reason || 'Upload not authorized');
      }
    }

    // Generate photo ID and storage path
    const photoId = `photo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const storagePath = generatePhotoStoragePath({
      libraryId: input.libraryId,
      photoId,
      fileName: input.originalName,
      isOriginal: true,
    });

    // Upload to Cloud Storage
    const storageRef = ref(this.storage, storagePath);
    await uploadString(storageRef, input.dataUrl, 'data_url');

    // Generate thumbnail path (backend will handle actual thumbnail generation)
    const thumbnailPath = getThumbnailPath(storagePath);

    // Create photo document with storage paths (not URLs)
    // Images will be served through the API endpoint with authentication
    const photoData: Omit<Photo, 'id'> = {
      libraryId: input.libraryId,
      albumIds: [],
      originalName: input.originalName,
      storagePath, // Store the storage path, not the URL
      thumbnailPath, // Store thumbnail path for future use
      status: 'ready' as const,
      metadata: (input.metadata as Photo['metadata']) || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isFavorite: false,
      tags: [],
      rating: 0,
      flag: null,
      colorLabel: null,
    };

    const docRef = await addDoc(collection(this.db, COLLECTIONS.PHOTOS), photoData);

    // Record operation if authorizer provided
    if (this.authorizer?.recordOperation) {
      await this.authorizer.recordOperation({
        operationId: `upload_${docRef.id}`,
        userId,
        operationType: 'upload',
        resourceType: 'photo',
        resourceId: docRef.id,
        metadata: {
          fileName: input.originalName,
          fileSizeBytes: file.size,
          mimeType: input.metadata?.mimeType || file.type,
          storagePath,
        },
        timestamp: new Date().toISOString(),
        success: true,
      });
    }

    return {
      id: docRef.id,
      ...photoData,
    };
  }

  async updatePhoto(photoId: string, input: UpdatePhotoInput): Promise<Photo> {
    const docRef = doc(this.db, COLLECTIONS.PHOTOS, photoId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error('Photo not found');
    }

    const updates: Partial<Photo> = {
      updatedAt: new Date().toISOString(),
    };

    if (input.isFavorite !== undefined) {
      updates.isFavorite = input.isFavorite;
    }

    if (input.tags !== undefined) {
      updates.tags = input.tags;
    }

    if (input.albumIds !== undefined) {
      updates.albumIds = input.albumIds;
    }

    if (input.rating !== undefined) {
      if (!isPhotoRating(input.rating)) {
        throw new Error(`Invalid rating: ${String(input.rating)} (expected integer 0–5).`);
      }
      updates.rating = input.rating;
    }

    if (input.flag !== undefined) {
      if (!isPhotoFlag(input.flag)) {
        throw new Error(`Invalid flag: ${String(input.flag)} (expected 'pick' | 'reject' | null).`);
      }
      updates.flag = input.flag;
    }

    if (input.colorLabel !== undefined) {
      if (!isPhotoColorLabel(input.colorLabel)) {
        throw new Error(
          `Invalid colorLabel: ${String(input.colorLabel)} (expected one of ${PHOTO_COLOR_LABEL_VALUES.join(
            ', '
          )}, or null).`
        );
      }
      updates.colorLabel = input.colorLabel;
    }

    await updateDoc(docRef, updates);

    const updatedSnap = await getDoc(docRef);
    return this.mapDocToPhoto(updatedSnap);
  }

  async deletePhoto(photoId: string): Promise<void> {
    const docRef = doc(this.db, COLLECTIONS.PHOTOS, photoId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error('Photo not found');
    }

    const photo = this.mapDocToPhoto(docSnap);
    const userId = photo.libraryId.replace('library-', '');

    // Call authorization service if provided
    if (this.authorizer?.authorizeDelete) {
      const fileSizeBytes = photo.metadata?.sizeBytes || 0;
      const authResult = await this.authorizer.authorizeDelete({
        userId,
        resourceType: 'photo',
        resourceId: photoId,
        fileSizeBytes,
      });

      if (!authResult.authorized) {
        throw new Error(authResult.reason || 'Delete not authorized');
      }
    }

    // Delete from Cloud Storage
    try {
      const storageRef = ref(this.storage, photo.storagePath);
      await deleteObject(storageRef);

      // Also delete thumbnail if exists
      if (photo.thumbnailPath) {
        const thumbnailRef = ref(this.storage, photo.thumbnailPath);
        await deleteObject(thumbnailRef);
      }
    } catch (error) {
      console.error('Failed to delete storage files:', error);
      // Continue with Firestore deletion even if storage deletion fails
    }

    // Delete Firestore document
    await deleteDoc(docRef);

    // Record operation if authorizer provided
    if (this.authorizer?.recordOperation) {
      await this.authorizer.recordOperation({
        operationId: `delete_${photoId}`,
        userId,
        operationType: 'delete',
        resourceType: 'photo',
        resourceId: photoId,
        metadata: {
          fileName: photo.originalName,
          fileSizeBytes: photo.metadata?.sizeBytes || 0,
          storagePath: photo.storagePath,
        },
        timestamp: new Date().toISOString(),
        success: true,
      });
    }
  }

  async bulkAddToAlbum(input: BulkAddToAlbumInput): Promise<BulkAddToAlbumResult> {
    const results = await Promise.all(
      input.photoIds.map(async (photoId) => {
        try {
          const docRef = doc(this.db, COLLECTIONS.PHOTOS, photoId);
          const docSnap = await getDoc(docRef);

          if (!docSnap.exists()) {
            return {
              photoId,
              status: 'skipped' as const,
              code: 'not_found' as const,
            };
          }

          const photo = this.mapDocToPhoto(docSnap);

          // Check if already in album
          if (photo.albumIds.includes(input.albumId)) {
            return {
              photoId,
              status: 'skipped' as const,
              code: 'already_in_album' as const,
            };
          }

          // Add to album
          await updateDoc(docRef, {
            albumIds: [...photo.albumIds, input.albumId],
            updatedAt: new Date().toISOString(),
          });

          return {
            photoId,
            status: 'added' as const,
          };
        } catch (error) {
          console.error(`Failed to add photo ${photoId} to album:`, error);
          return {
            photoId,
            status: 'skipped' as const,
            code: 'not_found' as const,
          };
        }
      })
    );

    return {
      albumId: input.albumId,
      results,
    };
  }

  /**
   * Convert data URL to File object for size calculation
   */
  private async dataUrlToFile(dataUrl: string, fileName: string): Promise<File> {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return new File([blob], fileName, { type: blob.type });
  }

  /**
   * Map Firestore document to Photo type
   */
  private mapDocToPhoto(docSnap: DocumentSnapshot): Photo {
    const data = docSnap.data()!;
    return {
      id: docSnap.id,
      libraryId: data.libraryId,
      albumIds: data.albumIds || [],
      originalName: data.originalName,
      storagePath: data.storagePath,
      thumbnailPath: data.thumbnailPath || null,
      status: data.status,
      metadata: data.metadata || null,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      isFavorite: data.isFavorite || false,
      tags: data.tags || [],
      rating: isPhotoRating(data.rating) ? data.rating : 0,
      flag: isPhotoFlag(data.flag) ? data.flag : null,
      colorLabel: isPhotoColorLabel(data.colorLabel) ? data.colorLabel : null,
    };
  }
}