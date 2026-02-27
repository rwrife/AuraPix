import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';

/**
 * Firebase configuration and initialization utilities for AuraPix.
 * This is a generic Firebase setup that can be used by any project.
 */

export interface FirebaseConfig {
  firebaseOptions: FirebaseOptions;
  storageBucket?: string;
}

export interface FirebaseInstances {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
}

/**
 * Initialize Firebase services for AuraPix.
 * This function is idempotent - it will return existing instances if already initialized.
 */
export function initializeFirebaseServices(config: FirebaseConfig): FirebaseInstances {
  const app = initializeApp(config.firebaseOptions);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const storage = getStorage(app, config.storageBucket);

  return { app, auth, db, storage };
}

/**
 * Helper to check if Firebase is configured.
 * Useful for conditional initialization.
 */
export function isFirebaseConfigured(config: Partial<FirebaseConfig>): config is FirebaseConfig {
  return !!(
    config.firebaseOptions &&
    config.firebaseOptions.apiKey &&
    config.firebaseOptions.projectId
  );
}