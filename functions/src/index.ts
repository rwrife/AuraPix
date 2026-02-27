import * as functions from 'firebase-functions';
import express from 'express';
import pinoHttp from 'pino-http';
import { storageConfig, authConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authMiddleware } from './middleware/auth.js';
import { apiVersionMiddleware } from './middleware/apiVersion.js';
import { firebaseAuthMiddleware, initializeFirebaseAuth } from './middleware/firebaseAuth.js';
import { FirebaseStorageAdapter } from './adapters/storage/FirebaseStorageAdapter.js';
import { FirestoreDataAdapter } from './adapters/data/FirestoreDataAdapter.js';
import { LocalDiskStorage } from './adapters/storage/LocalDiskStorage.js';
import { LocalJsonData } from './adapters/data/LocalJsonData.js';

// Import routes
import imagesRouter from './routes/images.js';
import internalRouter from './routes/internal.js';
import editsRouter from './routes/edits.js';

const app = express();

// Request logging
app.use(pinoHttp({ logger }));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Idempotency-Key, X-API-Version'
  );
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  
  next();
});

// Initialize adapters based on configuration
let storageAdapter;
let dataAdapter;

if (storageConfig.mode === 'firebase') {
  // Firebase mode
  logger.info('Initializing Firebase adapters');
  
  if (!storageConfig.firebase.storageBucket) {
    throw new Error('FIREBASE_STORAGE_BUCKET environment variable is required in Firebase mode');
  }
  
  storageAdapter = new FirebaseStorageAdapter(storageConfig.firebase.storageBucket);
  dataAdapter = new FirestoreDataAdapter();
  
  // Initialize Firebase Authentication
  if (authConfig.mode === 'firebase') {
    initializeFirebaseAuth();
  }
} else {
  // Local mode
  logger.info('Initializing local adapters');
  storageAdapter = new LocalDiskStorage(storageConfig.local.storagePath);
  dataAdapter = new LocalJsonData(storageConfig.local.databasePath);
}

// Make adapters available to routes
app.locals.storageAdapter = storageAdapter;
app.locals.dataAdapter = dataAdapter;

// API version compatibility policy
app.use(apiVersionMiddleware);

// Authentication middleware
if (authConfig.mode === 'firebase') {
  app.use(firebaseAuthMiddleware);
} else {
  app.use(authMiddleware);
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    storage: storageConfig.mode,
    auth: authConfig.mode,
  });
});

// Mount routes
app.use('/images', imagesRouter);
app.use('/internal', internalRouter);
app.use('/edits', editsRouter);

// Error handlers (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

// Export for Firebase Functions  
export const api = functions.https.onRequest(app);

// Note: Cloud Storage triggers would be implemented using Firebase Functions v2 API:
// import { onObjectFinalized, onObjectDeleted } from 'firebase-functions/v2/storage';
// 
// export const onFileUploaded = onObjectFinalized(async (event) => {
//   logger.info({ object: event.data.name }, 'File uploaded to Cloud Storage');
//   // TODO: Trigger thumbnail generation for uploaded images
// });
//
// export const onFileDeleted = onObjectDeleted(async (event) => {
//   logger.info({ object: event.data.name }, 'File deleted from Cloud Storage');
//   // TODO: Clean up related resources (thumbnails, metadata)
// });
