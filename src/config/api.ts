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
export function getApiUrl(endpoint: string): string {
  const base = API_CONFIG.baseUrl.replace(/\/$/, ''); // Remove trailing slash
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${base}${path}`;
}

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