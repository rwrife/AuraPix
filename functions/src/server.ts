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

// Body parsing — accept CSP violation report content types alongside JSON
// so the `/embed/csp-report` endpoint can parse the browser-posted body.
app.use(
  express.json({
    type: [
      'application/json',
      'application/csp-report',
      'application/reports+json',
    ],
  })
);
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
import { createWebhookDeliveriesRouter } from './routes/webhookDeliveriesV1.js';
import { createPhotosV1Router } from './routes/photosV1.js';
import {
  createEmbedV1Router,
  createEmbedCspMiddleware,
  loadAllowedOriginsForTenant,
} from './routes/embedV1.js';
import { PhotosService } from './domain/photos/PhotosService.js';
import { resolveTenant } from './middleware/resolveTenant.js';
import { InMemoryUsageMeteringBus } from './services/metering/UsageMeteringBus.js';
import {
  getHostWebhookSink,
  getWebhookDeliveryStore,
} from './services/metering/index.js';
import {
  InMemoryDailyDocStore,
  UsageRollupConsumer,
} from './services/metering/UsageRollupConsumer.js';

// --- Metering / usage rollups (issue #133) ---
// Initialized early so downstream middleware (e.g. embed CSP) can pick up
// `app.locals.meteringBus` and emit events into the same bus.
const meteringBus = new InMemoryUsageMeteringBus();
const usageDailyStore = new InMemoryDailyDocStore();
const usageRollupConsumer = new UsageRollupConsumer(usageDailyStore);
usageRollupConsumer.attach(meteringBus);
app.locals.meteringBus = meteringBus;
app.locals.usageDailyStore = usageDailyStore;

// --- Embed handshake CSP middleware (issue #163) ---
// Sets `Content-Security-Policy: frame-ancestors ...` + `X-Frame-Options`
// on tenant-scoped routes that may be loaded inside a host iframe. Mounted
// BEFORE the per-tenant routes so the headers are attached to the response
// before the route handler ends it. Tenant id is parsed from the path
// pattern `/{prefix}/tenants/:tenantId/...`.
const embedCspMiddleware = createEmbedCspMiddleware({
  tenantFromReq: (req): string | null => {
    // When mounted on /api/v1 or /v1, Express strips that prefix from req.url
    // before this middleware sees the request. Match against req.path so we
    // ignore any query string.
    const match = req.path.match(/^\/tenants\/([a-zA-Z0-9_-]{1,64})(?:\/|$)/);
    if (match) return match[1] ?? null;
    const header = req.headers['x-aurapix-tenant-id'];
    const headerVal = Array.isArray(header) ? header[0] : header;
    if (typeof headerVal === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(headerVal)) {
      return headerVal;
    }
    return null;
  },
  loadOrigins: (tenantId) => loadAllowedOriginsForTenant(dataAdapter, tenantId),
  reportUriTemplate: '/api/v1/tenants/{tenantId}/embed/csp-report',
  meteringBus: meteringBus as unknown as { emit?: (e: unknown) => void },
});
app.use('/api/v1', embedCspMiddleware);
app.use('/v1', embedCspMiddleware);

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

// Photos: soft-delete (Trash) + restore + trashed list (issue #152).
// Mounted at both `/v1/photos` (spec) and `/api/v1/photos` (in-product) so
// hosts can call the documented contract URL while clients keep the
// `/api` prefix used elsewhere.
const photosService = new PhotosService({
  dataAdapter,
  storageAdapter,
});
app.use(
  '/v1/photos',
  authMiddleware,
  resolveTenant,
  createPhotosV1Router(photosService)
);
app.use(
  '/api/v1/photos',
  authMiddleware,
  resolveTenant,
  createPhotosV1Router(photosService)
);

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
app.use('/api/signing', authMiddleware, createSigningRouter(dataAdapter));

// Host webhook delivery observability + manual replay (issue #144).
// Host-key-authenticated: accepts `Authorization: Bearer ak_live_...` with
// the `webhooks.write` scope. Falls through optional Firebase auth so the
// per-route guard (`requireUserOrTenantScopes`) can issue the right 401/403.
const webhookDeliveryStore = getWebhookDeliveryStore();
app.locals.webhookDeliveryStore = webhookDeliveryStore;
app.use(
  '/api/v1/tenants',
  hostApiKeyAuth,
  optionalAuthMiddleware,
  createWebhookDeliveriesRouter({
    store: webhookDeliveryStore,
    sink: getHostWebhookSink() ?? undefined,
  })
);

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

// --- Embed handshake routes (issue #163) ---
// GET/PUT allowed-origins is host-API-key gated (or owner user); the CSP
// report endpoint is unauthenticated so browsers can post violation
// reports. Mounted on both `/api/v1/tenants` (in-product) and
// `/v1/tenants` (host-facing spec URL).
function canWriteEmbedConfig(
  req: import('express').Request,
  tenantId: string
): boolean {
  // Host API key with tenants.write scope, scoped to the same tenant.
  if (req.tenant) {
    if (req.tenant.id !== tenantId) return false;
    return req.tenant.scopes.includes('tenants.write' as never);
  }
  // Otherwise, an authenticated user is treated as tenant owner (legacy
  // single-tenant-per-user mapping).
  return Boolean(req.user);
}

const embedRouter = createEmbedV1Router(dataAdapter, {
  canWriteEmbedConfig,
});
app.use(
  '/api/v1/tenants',
  hostApiKeyAuth,
  optionalAuthMiddleware,
  embedRouter
);
app.use(
  '/v1/tenants',
  hostApiKeyAuth,
  optionalAuthMiddleware,
  embedRouter
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
