/**
 * React hook for managing image authentication via HMAC-signed URLs
 * 
 * Replaces Service Worker approach with signing key management
 * Provides signing keys to components for generating signed image URLs
 */

import { useEffect, useState, createContext, useContext, createElement, type ReactNode, type ReactElement } from 'react';
import { SigningKeyManager } from '../services/imageAuth/SigningKeyManager.js';
import type { ClientSigningKey } from '../domain/imageAuth/types.js';
import type { AuthService } from '../domain/auth/contract.js';

/**
 * Context for sharing signing key manager across components
 */
interface ImageAuthContextValue {
  signingKeyManager: SigningKeyManager | null;
  signingKey: ClientSigningKey | null;
  isReady: boolean;
}

const ImageAuthContext = createContext<ImageAuthContextValue>({
  signingKeyManager: null,
  signingKey: null,
  isReady: false,
});

/**
 * Provider component that manages signing key lifecycle
 */
export function ImageAuthProvider({ 
  children, 
  authService 
}: { 
  children: ReactNode; 
  authService: AuthService;
}): ReactElement {
  const [signingKeyManager] = useState(() => new SigningKeyManager(authService));
  const [signingKey, setSigningKey] = useState<ClientSigningKey | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let mounted = true;

    const initializeSigningKey = async () => {
      try {
        // Check if user is authenticated
        const currentUser = await authService.getCurrentUser();
        
        if (currentUser) {
          console.debug('[ImageAuth] User authenticated, fetching signing key');
          const key = await signingKeyManager.getSigningKey();
          
          if (mounted) {
            setSigningKey(key);
            setIsReady(true);
            console.debug('[ImageAuth] Signing key ready, expires at:', key.expiresAt.toISOString());
          }
        } else {
          console.debug('[ImageAuth] No authenticated user, images require share tokens');
          setIsReady(true);
        }
      } catch (error) {
        console.error('[ImageAuth] Failed to initialize signing key:', error);
        if (mounted) {
          setIsReady(true); // Mark ready even on error so app doesn't hang
        }
      }
    };

    initializeSigningKey();

    // Note: Auth state change monitoring not implemented in contract
    // Future: Add onAuthStateChanged to AuthService contract for real-time updates

    return () => {
      mounted = false;
      signingKeyManager.clear();
    };
  }, [authService, signingKeyManager]);

  return createElement(
    ImageAuthContext.Provider,
    { value: { signingKeyManager, signingKey, isReady } },
    children
  );
}

/**
 * Hook to access image authentication context
 * @returns Image auth context with signing key manager and current key
 */
export function useImageAuth(): ImageAuthContextValue {
  const context = useContext(ImageAuthContext);
  
  if (!context) {
    throw new Error('useImageAuth must be used within ImageAuthProvider');
  }
  
  return context;
}