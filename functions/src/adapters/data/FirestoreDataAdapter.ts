import { Firestore, Query, WhereFilterOp } from '@google-cloud/firestore';
import { DataAdapter, QueryFilter } from './DataAdapter.js';
import { logger } from '../../utils/logger.js';
import { AppError } from '../../middleware/errorHandler.js';

export class FirestoreDataAdapter implements DataAdapter {
  private firestore: Firestore;

  constructor() {
    this.firestore = new Firestore();
    logger.info('Firestore data adapter initialized');
  }

  async storeData(collection: string, id: string, data: any): Promise<void> {
    try {
      const docRef = this.firestore.collection(collection).doc(id);
      await docRef.set(data, { merge: false });
      
      logger.debug({ collection, id }, 'Document stored in Firestore');
    } catch (error) {
      logger.error({ error, collection, id }, 'Failed to store document in Firestore');
      throw new AppError(
        500,
        'DATA_WRITE_ERROR',
        'Failed to store document in Firestore'
      );
    }
  }

  async fetchData<T>(collection: string, id: string): Promise<T | null> {
    try {
      const docRef = this.firestore.collection(collection).doc(id);
      const doc = await docRef.get();
      
      if (!doc.exists) {
        logger.debug({ collection, id }, 'Document not found in Firestore');
        return null;
      }

      const data = doc.data() as T;
      logger.debug({ collection, id }, 'Document fetched from Firestore');
      return data;
    } catch (error) {
      logger.error({ error, collection, id }, 'Failed to fetch document from Firestore');
      throw new AppError(
        500,
        'DATA_READ_ERROR',
        'Failed to fetch document from Firestore'
      );
    }
  }

  async queryData<T>(
    collection: string,
    filters?: QueryFilter[]
  ): Promise<T[]> {
    try {
      let query: Query = this.firestore.collection(collection);

      if (filters && filters.length > 0) {
        for (const filter of filters) {
          query = query.where(
            filter.field,
            filter.operator as WhereFilterOp,
            filter.value
          );
        }
      }

      const snapshot = await query.get();
      const results = snapshot.docs.map((doc) => doc.data() as T);
      
      logger.debug(
        { collection, filterCount: filters?.length || 0, resultCount: results.length },
        'Query executed in Firestore'
      );
      
      return results;
    } catch (error) {
      logger.error({ error, collection }, 'Failed to query documents in Firestore');
      throw new AppError(
        500,
        'DATA_QUERY_ERROR',
        'Failed to query documents in Firestore'
      );
    }
  }

  async updateData(
    collection: string,
    id: string,
    updates: Partial<any>
  ): Promise<void> {
    try {
      const docRef = this.firestore.collection(collection).doc(id);
      
      // Check if document exists
      const doc = await docRef.get();
      if (!doc.exists) {
        throw new AppError(404, 'DOCUMENT_NOT_FOUND', `Document not found: ${id}`);
      }

      await docRef.update(updates);
      
      logger.debug({ collection, id, updateKeys: Object.keys(updates) }, 'Document updated in Firestore');
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logger.error({ error, collection, id }, 'Failed to update document in Firestore');
      throw new AppError(
        500,
        'DATA_UPDATE_ERROR',
        'Failed to update document in Firestore'
      );
    }
  }

  async deleteData(collection: string, id: string): Promise<void> {
    try {
      const docRef = this.firestore.collection(collection).doc(id);
      await docRef.delete();
      
      logger.debug({ collection, id }, 'Document deleted from Firestore');
    } catch (error) {
      logger.error({ error, collection, id }, 'Failed to delete document from Firestore');
      throw new AppError(
        500,
        'DATA_DELETE_ERROR',
        'Failed to delete document from Firestore'
      );
    }
  }

  async exists(collection: string, id: string): Promise<boolean> {
    try {
      const docRef = this.firestore.collection(collection).doc(id);
      const doc = await docRef.get();
      return doc.exists;
    } catch (error) {
      logger.error({ error, collection, id }, 'Failed to check document existence');
      return false;
    }
  }

  async listIds(collection: string): Promise<string[]> {
    try {
      const snapshot = await this.firestore.collection(collection).select().get();
      const ids = snapshot.docs.map((doc) => doc.id);
      
      logger.debug({ collection, count: ids.length }, 'Document IDs listed from Firestore');
      return ids;
    } catch (error) {
      logger.error({ error, collection }, 'Failed to list document IDs from Firestore');
      throw new AppError(
        500,
        'DATA_LIST_ERROR',
        'Failed to list document IDs from Firestore'
      );
    }
  }

  async getPhoto(libraryId: string, photoId: string): Promise<any | null> {
    try {
      logger.info({ 
        libraryId, 
        photoId,
        nestedPath: `libraries/${libraryId}/photos/${photoId}`,
        flatPath: `photos/${photoId}`
      }, 'Attempting to fetch photo from Firestore');
      
      // Try nested path first: libraries/{libraryId}/photos/{photoId}
      const nestedPhotoRef = this.firestore
        .collection('libraries')
        .doc(libraryId)
        .collection('photos')
        .doc(photoId);
      
      const nestedDoc = await nestedPhotoRef.get();
      
      if (nestedDoc.exists) {
        const data = nestedDoc.data();
        logger.info({ 
          libraryId, 
          photoId,
          foundIn: 'nested',
          hasStoragePath: !!data?.storagePath,
          hasStoragePaths: !!data?.storagePaths,
          storagePath: data?.storagePath
        }, 'Photo found in nested collection');
        return data;
      }
      
      // Try flat path: photos/{photoId}
      const flatPhotoRef = this.firestore
        .collection('photos')
        .doc(photoId);
      
      const flatDoc = await flatPhotoRef.get();
      
      if (flatDoc.exists) {
        const data = flatDoc.data();
        logger.info({ 
          libraryId, 
          photoId,
          foundIn: 'flat',
          hasStoragePath: !!data?.storagePath,
          hasStoragePaths: !!data?.storagePaths,
          storagePath: data?.storagePath
        }, 'Photo found in flat collection');
        return data;
      }
      
      // Not found in either location - debug both
      logger.warn({ 
        libraryId, 
        requestedPhotoId: photoId
      }, 'Photo not found in either nested or flat collection, checking what exists...');
      
      // List photos in nested collection
      const nestedPhotosSnapshot = await this.firestore
        .collection('libraries')
        .doc(libraryId)
        .collection('photos')
        .limit(5)
        .get();
      
      const nestedPhotoIds = nestedPhotosSnapshot.docs.map(d => d.id);
      
      // List photos in flat collection with this libraryId
      const flatPhotosSnapshot = await this.firestore
        .collection('photos')
        .where('libraryId', '==', libraryId)
        .limit(5)
        .get();
      
      const flatPhotoIds = flatPhotosSnapshot.docs.map(d => d.id);
      
      logger.warn({ 
        libraryId, 
        requestedPhotoId: photoId,
        nestedPhotoIds,
        nestedCount: nestedPhotoIds.length,
        flatPhotoIds,
        flatCount: flatPhotoIds.length
      }, 'Photo not found - available photos in both collections');
      
      return null;
    } catch (error) {
      logger.error({ error, libraryId, photoId }, 'Failed to fetch photo from Firestore');
      throw new AppError(
        500,
        'DATA_READ_ERROR',
        'Failed to fetch photo from Firestore'
      );
    }
  }
}
