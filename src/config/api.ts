/**
 * API configuration for AuraPix backend
 */

const isDevelopment = import.meta.env.DEV;

// Local development: point to local server at localhost:3001
// Production: point to deployed Cloud Function
export const AURAPIX_API_BASE_URL = isDevelopment
  ? 'http://localhost:3001'
  : 'https://us-central1-huddlepix-33a54.cloudfunctions.net/api';

export const API_CONFIG = {
  baseURL: AURAPIX_API_BASE_URL,
  timeout: 30000, // 30 seconds
  headers: {
    'Content-Type': 'application/json',
  },
} as const;

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

export const buildUploadUrl = (libraryId: string): string => {
  return `${AURAPIX_API_BASE_URL}/images/${libraryId}`;
};

export const buildEditsUrl = (libraryId: string, photoId: string): string => {
  return `${AURAPIX_API_BASE_URL}/edits/${libraryId}/${photoId}`;
};