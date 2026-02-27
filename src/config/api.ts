/**
 * API Configuration
 * Central configuration for backend API endpoints
 */

export const API_CONFIG = {
  baseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001',
  timeout: 30000, // 30 seconds
  healthCheckInterval: 30000, // 30 seconds
} as const;

/**
 * Get the full API URL for a given endpoint
 */
export const getApiUrl = (path: string): string => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${AURAPIX_API_BASE_URL}${normalizedPath}`;
};

// Export individual endpoint builders if needed
export const buildImageUrl = (libraryId: string, photoId: string, params?: {
  size?: 'small' | 'medium' | 'large' | 'original';
  format?: 'webp' | 'jpeg';
}): string => {
  const url = new URL(`${AURAPIX_API_BASE_URL}/images/${libraryId}/${photoId}`);
  if (params?.size) url.searchParams.set('size', params.size);
  if (params?.format) url.searchParams.set('format', params.format);
  return url.toString();
};

/**
 * Check if we're in development mode
 */
export function isDevelopment(): boolean {
  return import.meta.env.VITE_ENV === 'development' || import.meta.env.DEV;
}

/**
 * Check if we're using local backend
 */
export function isLocalBackend(): boolean {
  return API_CONFIG.baseUrl.includes('localhost') || API_CONFIG.baseUrl.includes('127.0.0.1');
}
