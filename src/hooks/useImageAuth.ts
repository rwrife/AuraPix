/**
 * React hook for managing image authentication via Service Worker
 */

import { useEffect, useState } from 'react';
import { getAuth } from 'firebase/auth';

const SW_PATH = '/image-auth-sw.js';

// Log for debugging
console.log('[ImageAuth] Attempting to register Service Worker at:', SW_PATH);

/**
 * Hook to register and manage the image authentication Service Worker
 * Returns whether the service worker is ready
 */
export function useImageAuth(): boolean {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    // Check if Service Workers are supported
    if (!('serviceWorker' in navigator)) {
      console.warn('Service Workers not supported in this browser');
      setIsReady(true); // Continue anyway, images will work without auth
      return;
    }

    let registration: ServiceWorkerRegistration | null = null;

    const setupServiceWorker = async () => {
      try {
        // Register the service worker
        console.log('[ImageAuth] Registering Service Worker...');
        registration = await navigator.serviceWorker.register(SW_PATH, {
          scope: '/',
        });

        console.log('[ImageAuth] Service Worker registered successfully:', registration.scope);
        console.log('[ImageAuth] Service Worker state:', registration.active?.state);

        // Wait for service worker to be active
        await navigator.serviceWorker.ready;

        // Set up auth token updates
        const auth = getAuth();
        
        // Send initial token if user is logged in
        if (auth.currentUser) {
          console.log('[ImageAuth] Current user found:', auth.currentUser.uid);
          const token = await auth.currentUser.getIdToken();
          console.log('[ImageAuth] Got initial token, length:', token.length);
          sendTokenToServiceWorker(token);
        } else {
          console.log('[ImageAuth] No current user at registration time');
        }

        // Listen for auth state changes
        const unsubscribe = auth.onAuthStateChanged(async (user) => {
          console.log('[ImageAuth] Auth state changed, user:', user ? user.uid : 'null');
          if (user) {
            try {
              const token = await user.getIdToken();
              console.log('[ImageAuth] Got token from auth state change, length:', token.length);
              sendTokenToServiceWorker(token);
            } catch (error) {
              console.error('[ImageAuth] Failed to get auth token:', error);
            }
          } else {
            console.log('[ImageAuth] User logged out, clearing token');
            sendTokenToServiceWorker(null);
          }
        });

        // Periodically refresh token (every 50 minutes, tokens expire after 1 hour)
        const refreshInterval = setInterval(async () => {
          const user = auth.currentUser;
          if (user) {
            try {
              const token = await user.getIdToken(true); // Force refresh
              sendTokenToServiceWorker(token);
            } catch (error) {
              console.error('[ImageAuth] Failed to refresh token:', error);
            }
          }
        }, 50 * 60 * 1000);

        setIsReady(true);

        // Cleanup
        return () => {
          unsubscribe();
          clearInterval(refreshInterval);
        };
      } catch (error) {
        console.error('[ImageAuth] Service Worker registration failed:', error);
        console.error('[ImageAuth] Error details:', error instanceof Error ? error.message : error);
        setIsReady(true); // Continue anyway
      }
    };

    setupServiceWorker();

    return () => {
      // Cleanup will be handled by the inner return
    };
  }, []);

  return isReady;
}

/**
 * Send auth token to the Service Worker
 */
function sendTokenToServiceWorker(token: string | null): void {
  console.log('[ImageAuth] sendTokenToServiceWorker called');
  console.log('[ImageAuth] Service Worker controller exists:', !!navigator.serviceWorker.controller);
  
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'UPDATE_TOKEN',
      token,
    });
    console.log('[ImageAuth] Token sent to Service Worker, token length:', token ? token.length : 0);
    console.log('[ImageAuth] Token preview:', token ? token.substring(0, 50) + '...' : 'null');
  } else {
    console.warn('[ImageAuth] No Service Worker controller available to send token to');
  }
}
