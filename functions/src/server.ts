import express from 'express';
import pinoHttp from 'pino-http';
import { serverConfig, storageConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authMiddleware, optionalAuthMiddleware } from './middleware/auth.js';
import { createHostApiKeyAuth } from './middleware/hostApiKeyAuth.js';
import { apiVersionMiddleware } from './middleware/apiVersion.js';
import { LocalDiskStorage } from './adapters/storage/LocalDiskStorage.js';
import { LocalJsonData } from './adapters/data/LocalJsonData.js';
import { FirebaseStorageAdapter } from './adapters/storage/FirebaseStorageAdapter.js';
import { FirestoreDataAdapter } from './adapters/data/FirestoreDataAdapter.js';
import { createDomainModules } from './composition/domainModules.js';

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

const domainModules = createDomainModules();

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
import { createSigningRouter } from './routes/signing.js';
import { createAlbumsRouter } from './routes/albums.js';
import { createAlbumsV1Router } from './routes/albumsV1.js';
import { createComplianceV1Router } from './routes/complianceV1.js';
import { createBrandingV1Router } from './routes/brandingV1.js';
import { createTenantUsageRouter } from './routes/tenantUsage.js';
import { createTenantUsersRouter } from './routes/tenantUsersV1.js';
import { InMemoryUsageMeteringBus } from './services/metering/UsageMeteringBus.js';
import {
  InMemoryDailyDocStore,
  UsageRollupConsumer,
} from './services/metering/UsageRollupConsumer.js';

// Mount routes
// Images route handles its own auth (signed URLs for GET, Bearer for POST)
app.use('/images', createImageRoutes(dataAdapter));

// /internal endpoints accept EITHER a Firebase user token OR a host API
// key (Authorization: Bearer ak_live_...). The hostApiKeyAuth middleware
// short-circuits on a valid key and sets req.tenant; otherwise we fall
// through to optional Firebase auth so per-route guards can decide what to
// require. Individual routes inside internalRouter enforce admin or scope
// requirements via requireUserOrTenantScopes / requireAdmin.
const hostApiKeyAuth = createHostApiKeyAuth(dataAdapter);
app.use('/internal', hostApiKeyAuth, optionalAuthMiddleware, internalRouter);
app.use('/edits', authMiddleware, editsRouter);

// Versioned API surface (desktop/web clients)
app.use('/api', apiVersionMiddleware);
app.use('/api/albums', authMiddleware, createAlbumsRouter(domainModules.albums));
app.use('/api/v1/albums', authMiddleware, createAlbumsV1Router(domainModules.albums));
app.use('/api/v1/compliance', authMiddleware, createComplianceV1Router(dataAdapter));

// --- Metering / usage rollups (issue #133) ---
// In-memory wiring suitable for local mode; Firebase mode will swap in a
// Pub/Sub bus and a Firestore-backed store in a follow-up issue.
const meteringBus = new InMemoryUsageMeteringBus();
const usageDailyStore = new InMemoryDailyDocStore();
const usageRollupConsumer = new UsageRollupConsumer(usageDailyStore);
usageRollupConsumer.attach(meteringBus);
app.locals.meteringBus = meteringBus;
app.locals.usageDailyStore = usageDailyStore;
app.use(
  '/api/v1/tenants',
  authMiddleware,
  createTenantUsageRouter({
    store: usageDailyStore,
    // Until the tenantId model lands, treat the authenticated user's uid as
    // their own tenantId (legacy single-tenant-per-user mapping).
    ownsTenant: async (userId, tenantId) => userId === tenantId,
  })
);
// Tenant user (membership) management. Host API key authenticated.
// Mount BEFORE branding's GET-public router so the /v1/tenants/:id/users
// paths are matched here first.
app.use(
  '/api/v1/tenants',
  hostApiKeyAuth,
  createTenantUsersRouter({
    dataAdapter,
    meteringBus: {
      emit: (event) => {
        // Bridge into the existing usage rollup bus where applicable.
        // user.* events are emitted via logger today; a follow-up wires the
        // shared MeteringBus end-to-end.
        logger.info({ event: 'metering', ...event }, 'metering event emitted');
      },
    },
  })
);

app.use('/api/signing', authMiddleware, createSigningRouter(dataAdapter));

// Tenant branding: GET is public (no auth), PUT requires auth.
// Use a per-method gate so the public GET is reachable without a Bearer token.
const brandingRouter = createBrandingV1Router(dataAdapter);
app.use(
  '/api/v1/tenants',
  (req, res, next) => {
    if (req.method === 'GET') return next();
    return authMiddleware(req, res, next);
  },
  brandingRouter
);

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
