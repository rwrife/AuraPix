import type { ClientSigningKey, SigningKeyResponse } from '../../domain/imageAuth/types.js';
import type { AuthService } from '../../domain/auth/contract.js';
import { API_CONFIG } from '../../config/api.js';

/**
 * Manages signing keys for generating signed image URLs
 * - Fetches keys from backend
 * - Caches keys in memory
 * - Auto-refreshes before expiration
 * - Handles both authenticated users and share tokens
 */
export class SigningKeyManager {
  private currentKey: ClientSigningKey | null = null;
  private refreshPromise: Promise<ClientSigningKey> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private authService: AuthService,
    private apiBaseUrl: string = API_CONFIG.baseUrl
  ) {}

  /**
   * Get current signing key, fetching if needed
   * @returns Current valid signing key
   */
  async getSigningKey(): Promise<ClientSigningKey> {
    // If we have a valid key, return it
    if (this.currentKey && !this.isKeyExpiringSoon(this.currentKey)) {
      return this.currentKey;
    }

    // If a refresh is in progress, wait for it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // Otherwise, fetch new key
    return this.refreshSigningKey();
  }

  /**
   * Get signing key for a share token (public access)
   * @param shareToken - Share token from URL
   * @returns Signing key for share access
   */
  async getSigningKeyForShare(shareToken: string): Promise<ClientSigningKey> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/signing/key/share/${shareToken}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get signing key for share: ${response.statusText}`);
      }

      const data: SigningKeyResponse = await response.json();
      
      return {
        key: data.key,
        expiresAt: new Date(data.expiresAt),
        shareToken: data.shareToken,
      };
    } catch (error) {
      console.error('Failed to get share signing key:', error, 'token:', shareToken.substring(0, 8));
      throw error;
    }
  }

  /**
   * Force refresh of signing key
   * @returns New signing key
   */
  async refreshSigningKey(): Promise<ClientSigningKey> {
    // Prevent multiple simultaneous refreshes
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.fetchSigningKey();

    try {
      const key = await this.refreshPromise;
      this.currentKey = key;
      this.scheduleRefresh(key);
      return key;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Check if key needs refreshing soon (within 5 minutes of expiration)
   */
  private isKeyExpiringSoon(key: ClientSigningKey): boolean {
    const now = new Date();
    const timeUntilExpiry = key.expiresAt.getTime() - now.getTime();
    const fiveMinutes = 5 * 60 * 1000;
    
    return timeUntilExpiry < fiveMinutes;
  }

  /**
   * Schedule automatic refresh before key expires
   */
  private scheduleRefresh(key: ClientSigningKey): void {
    // Clear existing timer
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    // Schedule refresh 5 minutes before expiration
    const now = new Date();
    const timeUntilExpiry = key.expiresAt.getTime() - now.getTime();
    const fiveMinutes = 5 * 60 * 1000;
    const refreshIn = Math.max(0, timeUntilExpiry - fiveMinutes);

    console.debug('Scheduled signing key refresh:', {
      expiresAt: key.expiresAt.toISOString(),
      refreshIn: Math.floor(refreshIn / 1000),
    });

    this.refreshTimer = setTimeout(() => {
      console.debug('Auto-refreshing signing key');
      this.refreshSigningKey().catch((error) => {
        console.error('Failed to auto-refresh signing key:', error);
      });
    }, refreshIn);
  }

  /**
   * Fetch new signing key from backend
   */
  private async fetchSigningKey(): Promise<ClientSigningKey> {
    try {
      // Get current user session for auth token
      const session = await this.authService.getSession();
      if (!session) {
        throw new Error('User not authenticated');
      }

      const token = session.token;
      if (!token) {
        throw new Error('Failed to get auth token');
      }

      // Request signing key from backend
      const response = await fetch(`${this.apiBaseUrl}/api/signing/key`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get signing key: ${response.statusText}`);
      }

      const data: SigningKeyResponse = await response.json();
      
      console.debug('Received signing key from backend:', {
        expiresAt: data.expiresAt,
        hasUserId: !!data.userId,
      });

      return {
        key: data.key,
        expiresAt: new Date(data.expiresAt),
        userId: data.userId,
      };
    } catch (error) {
      console.error('Failed to fetch signing key:', error);
      throw error;
    }
  }

  /**
   * Clear cached key and cancel scheduled refresh
   */
  clear(): void {
    this.currentKey = null;
    this.refreshPromise = null;
    
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    console.debug('Signing key cache cleared');
  }

  /**
   * Check if manager has a valid cached key
   */
  hasValidKey(): boolean {
    return this.currentKey !== null && !this.isKeyExpiringSoon(this.currentKey);
  }
}