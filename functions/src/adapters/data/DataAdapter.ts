/**
 * Abstract data storage interface for host-agnostic database operations.
 * Implementations: LocalJsonData (dev), FirestoreData (prod)
 */

export interface QueryFilter {
  field: string;
  operator: '==' | '!=' | '>' | '>=' | '<' | '<=';
  value: any;
}

export interface DataAdapter {
  /**
   * Store a document in a collection
   */
  storeData<T>(collection: string, id: string, data: T): Promise<void>;

  /**
   * Fetch a document from a collection
   */
  fetchData<T>(collection: string, id: string): Promise<T | null>;

  /**
   * Query documents from a collection
   */
  queryData<T>(
    collection: string,
    filters: QueryFilter[]
  ): Promise<T[]>;

  /**
   * Update a document in a collection
   */
  updateData<T>(
    collection: string,
    id: string,
    updates: Partial<T>
  ): Promise<void>;

  /**
   * Delete a document from a collection
   */
  deleteData(collection: string, id: string): Promise<void>;

  /**
   * Check if a document exists
   */
  exists(collection: string, id: string): Promise<boolean>;

  /**
   * List all document IDs in a collection
   */
  listIds(collection: string): Promise<string[]>;

  /**
   * Fetch a photo by libraryId and photoId
   * Convenience method for getting photos from the photos subcollection
   */
  getPhoto(libraryId: string, photoId: string): Promise<any | null>;
}
