import { config } from 'dotenv';
import { randomBytes } from 'crypto';

// Load environment variables
config();

export const serverConfig = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
} as const;

export const storageConfig = {
  mode: (process.env.STORAGE_MODE || 'local') as 'local' | 'firebase',
  local: {
    storagePath: process.env.LOCAL_STORAGE_PATH || './local-data/storage',
    databasePath: process.env.LOCAL_DATABASE_PATH || './local-data/database',
    cachePath: process.env.LOCAL_CACHE_PATH || './local-data/cache',
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  },
} as const;

export const cacheConfig = {
  memory: {
    maxSizeMB: parseInt(process.env.MEMORY_CACHE_MAX_SIZE_MB || '100', 10),
    ttlSeconds: parseInt(process.env.MEMORY_CACHE_TTL_SECONDS || '300', 10),
  },
  disk: {
    maxSizeMB: parseInt(process.env.DISK_CACHE_MAX_SIZE_MB || '1000', 10),
    ttlSeconds: parseInt(process.env.DISK_CACHE_TTL_SECONDS || '3600', 10),
  },
} as const;

export const imageConfig = {
  thumbnailSizes: {
    small: parseInt(process.env.THUMBNAIL_SMALL_SIZE || '200', 10),
    medium: parseInt(process.env.THUMBNAIL_MEDIUM_SIZE || '800', 10),
    large: parseInt(process.env.THUMBNAIL_LARGE_SIZE || '1600', 10),
  },
  quality: {
    jpeg: parseInt(process.env.JPEG_QUALITY || '85', 10),
    webp: parseInt(process.env.WEBP_QUALITY || '80', 10),
  },
} as const;

export const authConfig = {
  mode: (process.env.AUTH_MODE || 'mock') as 'mock' | 'firebase',
} as const;

export const featureConfig = {
  complianceExportsEnabled: process.env.FEATURE_COMPLIANCE_EXPORTS_ENABLED === 'true',
} as const;

// Comma-separated allowlist of user UIDs (or emails) treated as admins for
// internal management endpoints (e.g. minting tenant API keys).
const adminIds = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const adminConfig = {
  userIds: new Set<string>(adminIds),
} as const;

export function isAdminUser(user: { uid?: string; email?: string } | undefined): boolean {
  if (!user) return false;
  if (adminConfig.userIds.size === 0) return false;
  if (user.uid && adminConfig.userIds.has(user.uid)) return true;
  if (user.email && adminConfig.userIds.has(user.email)) return true;
  return false;
}

export const securityConfig = {
  uploadRateLimit: {
    windowMs: parseInt(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS || '60000', 10),
    maxRequests: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX_REQUESTS || '30', 10),
  },
  appCheck: {
    enforceUploads: process.env.APP_CHECK_ENFORCE_UPLOADS === 'true',
    bypassTokens: process.env.APP_CHECK_BYPASS_TOKENS || '',
  },
  hostPolicy: {
    uploadWebhookUrl: process.env.HOST_UPLOAD_POLICY_WEBHOOK_URL,
    timeoutMs: parseInt(process.env.HOST_UPLOAD_POLICY_TIMEOUT_MS || '1500', 10),
  },
} as const;

// Signing configuration for HMAC-signed URLs
// In production, SIGNING_MASTER_SECRET MUST be set in environment variables
// The secret should be generated during deployment and stored securely
export const signingConfig = {
  keyExpirationSeconds: parseInt(process.env.SIGNING_KEY_EXPIRATION || '3600', 10),
  urlExpirationSeconds: parseInt(process.env.SIGNED_URL_EXPIRATION || '600', 10),
  masterSecret: process.env.SIGNING_MASTER_SECRET || (() => {
    // Only generate random secret in development/local mode
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'SIGNING_MASTER_SECRET environment variable is required in production. ' +
        'Generate a secret with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }
    const generated = randomBytes(32).toString('hex');
    console.warn('[DEV] Generated temporary signing secret. Set SIGNING_MASTER_SECRET in production.');
    return generated;
  })(),
} as const;

// Per-tenant API rate limiter (issue #154). Token-bucket with `tenantId`
// keying, applied after `resolveTenant`. Defaults can be overridden per
// tenant via `tenants_config/{tenantId}` ({ rateLimit: { rps, burst } }).
export const tenantRateLimitConfig = {
  rps: parseInt(process.env.RATE_LIMIT_RPS || '20', 10),
  burst: parseInt(process.env.RATE_LIMIT_BURST || '60', 10),
  hostRps: parseInt(process.env.RATE_LIMIT_HOST_RPS || '100', 10),
} as const;
