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
  type Firestore,
} from 'firebase/firestore';
import type { AlbumsService } from '../../domain/albums/contract';
import type { Album, AlbumFolder, CreateAlbumInput, CreateFolderInput } from '../../domain/albums/types';
import { COLLECTIONS } from '../../config/collections';

/**
 * Firebase implementation of AlbumsService.
 * This is a generic adapter that can be used by any project using Firestore.
 */
export class FirebaseAlbumsService implements AlbumsService {
  private db: Firestore;
  private userId: string;

  constructor(db: Firestore, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  // ============================================================================
  // Folders
  // ============================================================================

  async listFolders(): Promise<AlbumFolder[]> {
    const foldersRef = collection(this.db, COLLECTIONS.ALBUM_FOLDERS);
    const q = query(
      foldersRef,
      where('userId', '==', this.userId),
      orderBy('createdAt', 'asc')
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      name: docSnap.data().name,
      createdAt: docSnap.data().createdAt,
    }));
  }

  async createFolder(input: CreateFolderInput): Promise<AlbumFolder> {
    const folderData = {
      userId: this.userId,
      name: input.name,
      createdAt: new Date().toISOString(),
    };

    const docRef = await addDoc(collection(this.db, COLLECTIONS.ALBUM_FOLDERS), folderData);

    return {
      id: docRef.id,
      name: folderData.name,
      createdAt: folderData.createdAt,
    };
  }

  async updateFolder(folderId: string, updates: Partial<Pick<AlbumFolder, 'name'>>): Promise<AlbumFolder> {
    const docRef = doc(this.db, COLLECTIONS.ALBUM_FOLDERS, folderId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error('Folder not found');
    }

    // Verify ownership
    if (docSnap.data().userId !== this.userId) {
      throw new Error('Not authorized to update this folder');
    }

    await updateDoc(docRef, updates);

    const updatedSnap = await getDoc(docRef);
    const data = updatedSnap.data()!;

    return {
      id: updatedSnap.id,
      name: data.name,
      createdAt: data.createdAt,
    };
  }

  async deleteFolder(folderId: string): Promise<void> {
    const docRef = doc(this.db, COLLECTIONS.ALBUM_FOLDERS, folderId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error('Folder not found');
    }

    // Verify ownership
    if (docSnap.data().userId !== this.userId) {
      throw new Error('Not authorized to delete this folder');
    }

    // Check if folder has albums
    const albumsInFolder = await this.getAlbumsInFolder(folderId);
    if (albumsInFolder.length > 0) {
      throw new Error('Cannot delete folder with albums. Move or delete albums first.');
    }

    await deleteDoc(docRef);
  }

  // ============================================================================
  // Albums
  // ============================================================================

  async listAlbums(): Promise<Album[]> {
    const albumsRef = collection(this.db, COLLECTIONS.ALBUMS);
    const q = query(
      albumsRef,
      where('userId', '==', this.userId),
      orderBy('createdAt', 'desc')
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map((docSnap) => {
      const data = docSnap.data();
      return {
        id: docSnap.id,
        name: data.name,
        folderId: data.folderId || null,
        createdAt: data.createdAt,
      };
    });
  }

  async getAlbum(albumId: string): Promise<Album | null> {
    const docRef = doc(this.db, COLLECTIONS.ALBUMS, albumId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      return null;
    }

    const data = docSnap.data();

    // Verify ownership
    if (data.userId !== this.userId) {
      return null;
    }

    return {
      id: docSnap.id,
      name: data.name,
      folderId: data.folderId || null,
      createdAt: data.createdAt,
    };
  }

  async createAlbum(input: CreateAlbumInput): Promise<Album> {
    // If folderId provided, verify it exists and user owns it
    if (input.folderId) {
      const folderRef = doc(this.db, COLLECTIONS.ALBUM_FOLDERS, input.folderId);
      const folderSnap = await getDoc(folderRef);

      if (!folderSnap.exists()) {
        throw new Error('Folder not found');
      }

      if (folderSnap.data().userId !== this.userId) {
        throw new Error('Not authorized to add albums to this folder');
      }
    }

    const albumData = {
      userId: this.userId,
      name: input.name,
      folderId: input.folderId || null,
      createdAt: new Date().toISOString(),
    };

    const docRef = await addDoc(collection(this.db, COLLECTIONS.ALBUMS), albumData);

    return {
      id: docRef.id,
      name: albumData.name,
      folderId: albumData.folderId,
      createdAt: albumData.createdAt,
    };
  }

  async updateAlbum(albumId: string, updates: Partial<Pick<Album, 'name' | 'folderId'>>): Promise<Album> {
    const docRef = doc(this.db, COLLECTIONS.ALBUMS, albumId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error('Album not found');
    }

    // Verify ownership
    if (docSnap.data().userId !== this.userId) {
      throw new Error('Not authorized to update this album');
    }

    // If updating folderId, verify folder exists and user owns it
    if (updates.folderId !== undefined && updates.folderId !== null) {
      const folderRef = doc(this.db, COLLECTIONS.ALBUM_FOLDERS, updates.folderId);
      const folderSnap = await getDoc(folderRef);

      if (!folderSnap.exists()) {
        throw new Error('Folder not found');
      }

      if (folderSnap.data().userId !== this.userId) {
        throw new Error('Not authorized to move album to this folder');
      }
    }

    await updateDoc(docRef, updates);

    const updatedSnap = await getDoc(docRef);
    const data = updatedSnap.data()!;

    return {
      id: updatedSnap.id,
      name: data.name,
      folderId: data.folderId || null,
      createdAt: data.createdAt,
    };
  }

  async deleteAlbum(albumId: string): Promise<void> {
    const docRef = doc(this.db, COLLECTIONS.ALBUMS, albumId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error('Album not found');
    }

    // Verify ownership
    if (docSnap.data().userId !== this.userId) {
      throw new Error('Not authorized to delete this album');
    }

    // Note: Photos in the album are not deleted, just their albumIds array is updated
    // This is handled by the caller if needed, or can be done via a cloud function trigger

    await deleteDoc(docRef);
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private async getAlbumsInFolder(folderId: string): Promise<Album[]> {
    const albumsRef = collection(this.db, COLLECTIONS.ALBUMS);
    const q = query(
      albumsRef,
      where('userId', '==', this.userId),
      where('folderId', '==', folderId)
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map((docSnap) => {
      const data = docSnap.data();
      return {
        id: docSnap.id,
        name: data.name,
        folderId: data.folderId || null,
        createdAt: data.createdAt,
      };
    });
  }
}