import express from 'express';
import pinoHttp from 'pino-http';
import { serverConfig, storageConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authMiddleware } from './middleware/auth.js';
import { LocalDiskStorage } from './adapters/storage/LocalDiskStorage.js';
import { LocalJsonData } from './adapters/data/LocalJsonData.js';

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
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  
  next();
});

// Initialize adapters based on configuration
const storageAdapter = new LocalDiskStorage(storageConfig.local.storagePath);
const dataAdapter = new LocalJsonData(storageConfig.local.databasePath);

// Make adapters available to routes
app.locals.storageAdapter = storageAdapter;
app.locals.dataAdapter = dataAdapter;

// Authentication middleware (applied to most routes)
app.use(authMiddleware);

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
import imagesRouter from './routes/images.js';
import internalRouter from './routes/internal.js';
import editsRouter from './routes/edits.js';

// Mount routes
app.use('/images', imagesRouter);
app.use('/internal', internalRouter);
app.use('/edits', editsRouter);

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
