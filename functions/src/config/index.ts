import { config } from 'dotenv';

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