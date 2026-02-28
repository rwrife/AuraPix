import express from 'express';
import pinoHttp from 'pino-http';
import { serverConfig, storageConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authMiddleware } from './middleware/auth.js';
import { apiVersionMiddleware } from './middleware/apiVersion.js';
import { LocalDiskStorage } from './adapters/storage/LocalDiskStorage.js';
import { LocalJsonData } from './adapters/data/LocalJsonData.js';
import { FirebaseStorageAdapter } from './adapters/storage/FirebaseStorageAdapter.js';
import { FirestoreDataAdapter } from './adapters/data/FirestoreDataAdapter.js';

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
  logger.info({ 
    mode: 'firebase',
    bucket: storageConfig.firebase.storageBucket,
    projectId: storageConfig.firebase.projectId
  }, 'Initializing Firebase adapters');
  
  if (!storageConfig.firebase.storageBucket) {
    throw new Error('FIREBASE_STORAGE_BUCKET environment variable is required in Firebase mode');
  }
  
  storageAdapter = new FirebaseStorageAdapter(storageConfig.firebase.storageBucket);
  dataAdapter = new FirestoreDataAdapter();
} else {
  // Local mode
  logger.info('Initializing local adapters');
  storageAdapter = new LocalDiskStorage(storageConfig.local.storagePath);
  dataAdapter = new LocalJsonData(storageConfig.local.databasePath);
}

// Make adapters available to routes
app.locals.storageAdapter = storageAdapter;
app.locals.dataAdapter = dataAdapter;

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: serverConfig.nodeEnv,
    storage: storageConfig.mode,
  });
});

// Import routes
import { createImageRoutes } from './routes/images.js';
import internalRouter from './routes/internal.js';
import editsRouter from './routes/edits.js';
import signingRouter from './routes/signing.js';

// Mount routes
// Images route handles its own auth (signed URLs for GET, Bearer for POST)
app.use('/images', createImageRoutes(dataAdapter));

// These routes require authentication
app.use('/internal', authMiddleware, internalRouter);
app.use('/edits', authMiddleware, editsRouter);
app.use('/api/signing', authMiddleware, signingRouter);

// Error handlers (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
const port = process.env.PORT || serverConfig.port;
app.listen(port, () => {
  logger.info(
    {
      port,
      env: serverConfig.nodeEnv,
      storage: storageConfig.mode,
    },
    'AuraPix Functions server started'
  );
});

export { app };
