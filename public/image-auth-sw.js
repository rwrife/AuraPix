/**
 * Service Worker for adding authentication tokens to image requests
 * This allows img tags to work with authenticated API endpoints
 */

const IMAGE_API_PATH = '/images/';

// Listen for messages from the main thread (for token updates)
let cachedToken = null;

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'UPDATE_TOKEN') {
    cachedToken = event.data.token;
    console.log('[SW] Auth token updated');
  }
});

// Intercept fetch requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Check if this is an image API request
  if (url.pathname.includes(IMAGE_API_PATH)) {
    event.respondWith(handleImageRequest(event.request));
  }
});

/**
 * Handle image requests by adding auth token as Bearer header
 */
async function handleImageRequest(request) {
  // If no token available, try request anyway
  if (!cachedToken) {
    console.warn('[SW] No auth token available for image request:', request.url);
    return fetch(request);
  }
  
  // Clone the headers and add Authorization Bearer token
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${cachedToken}`);
  
  // Create new request with Authorization header
  const newRequest = new Request(request.url, {
    method: request.method,
    headers: headers,
    mode: request.mode,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    referrer: request.referrer,
  });
  
  return fetch(newRequest);
}

// Service worker activation
self.addEventListener('activate', (event) => {
  console.log('[SW] Service worker activated');
  event.waitUntil(self.clients.claim());
});

self.addEventListener('install', (event) => {
  console.log('[SW] Service worker installed');
  self.skipWaiting();
});