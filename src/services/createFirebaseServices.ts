import type { Services } from './ServiceContext';
import type { FirebaseConfig, FirebaseInstances } from '../config/firebase';
import { initializeFirebaseServices } from '../config/firebase';
import { FirebaseAuthService } from '../adapters/auth/FirebaseAuthService';
import { FirebaseLibraryService } from '../adapters/library/FirebaseLibraryService';
import { FirebaseAlbumsService } from '../adapters/albums/FirebaseAlbumsService';
import { FirebaseSharingService } from '../adapters/sharing/FirebaseSharingService';
import { FirebaseUploadService } from '../adapters/uploads/FirebaseUploadService';
import { InMemorySmartAlbumsService } from '../adapters/smartAlbums/inMemorySmartAlbumsService';
import type { OperationAuthorizer } from '../domain/authorization/contract';

// ---------------------------------------------------------------------------
// Firebase service factory for AuraPix.
// Creates all service adapters using Firebase backend.
//
// To activate: set VITE_SERVICE_MODE=firebase in your .env file.
// ---------------------------------------------------------------------------

let firebaseInstances: FirebaseInstances | null = null;
let currentUserId: string | null = null;

export function createFirebaseServices(
  config: FirebaseConfig,
  userId: string,
  authorizer?: OperationAuthorizer
): Services {
  // Initialize Firebase instances if not already done
  if (!firebaseInstances) {
    firebaseInstances = initializeFirebaseServices(config);
  }

  // Cache user ID for potential reuse
  currentUserId = userId;

  // Create service instances
  const auth = new FirebaseAuthService(firebaseInstances.auth);
  const library = new FirebaseLibraryService(
    firebaseInstances.db,
    firebaseInstances.storage,
    authorizer
  );
  const albums = new FirebaseAlbumsService(firebaseInstances.db, userId);
  const sharing = new FirebaseSharingService(firebaseInstances.db);
  const uploads = new FirebaseUploadService(firebaseInstances.db, { userId });
  // Smart Albums (issue #165): Firebase mode currently uses the in-memory
  // adapter as a placeholder. The authoritative API lives at
  // /v1/smart-albums; a REST adapter can be wired here as a follow-up
  // without changing the contract.
  const smartAlbums = new InMemorySmartAlbumsService();

  return {
    auth,
    library,
    albums,
    sharing,
    smartAlbums,
    uploads,
  };
}

/**
 * Get the current Firebase instances (for debugging or advanced use cases)
 */
export function getFirebaseInstances(): FirebaseInstances | null {
  return firebaseInstances;
}

/**
 * Get the current user ID (for debugging or advanced use cases)
 */
export function getCurrentUserId(): string | null {
  return currentUserId;
}
