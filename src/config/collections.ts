/**
 * Firestore collection name constants for AuraPix.
 * Centralized to ensure consistency across all Firebase adapters.
 */

export const COLLECTIONS = {
  PHOTOS: 'photos',
  ALBUMS: 'albums',
  ALBUM_FOLDERS: 'albumFolders',
  SHARES: 'shares',
  OPERATIONS: 'operations',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];