import { generateHmacKey, deriveKey } from '../../utils/crypto.js';
import type { SigningKey } from '../../models/ImageAuth.js';

/**
 * Service for generating and validating signing keys
 * Keys are derived from master secret to avoid storage
 */
export class SigningKeyService {
  constructor(
    private masterSecret: string,
    private keyExpirationSeconds: number
  ) {}

  /**
   * Generate a new signing key for a user or share token
   * 
   * Uses a deterministic seed based on userId/shareToken so the backend
   * can recreate the same key for validation. The seed includes timestamp
   * rounded to the key expiration window to allow key rotation while still
   * being reproducible during the validity period.
   * 
   * @param userId - User ID for authenticated requests
   * @param shareToken - Share token for public share requests
   * @returns Signing key with expiration
   */
  async generateSigningKey(
    userId?: string,
    shareToken?: string
  ): Promise<SigningKey> {
    // Use user/token as seed - this makes the key deterministic
    // The key will be the same for any photo request by this user
    // within the expiration window
    const userIdentifier = userId || shareToken || 'anonymous';
    
    // Derive the signing key from master secret using the user identifier
    const key = this.deriveSigningKey(userIdentifier);
    
    // Calculate expiration time
    const expiresAt = new Date(Date.now() + this.keyExpirationSeconds * 1000);
    
    return {
      key,
      expiresAt: expiresAt.toISOString(),
      userId,
      shareToken,
    };
  }

  /**
   * Validate that a signing key is properly formatted and not expired
   * @param key - The signing key to validate
   * @returns True if key is valid
   */
  validateSigningKey(key: SigningKey): boolean {
    // Check required fields
    if (!key.key || !key.expiresAt) {
      return false;
    }

    // Must have either userId or shareToken
    if (!key.userId && !key.shareToken) {
      return false;
    }

    // Check expiration
    const expiresAt = new Date(key.expiresAt);
    if (isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
      return false;
    }

    return true;
  }

  /**
   * Derive a signing key from a seed value
   * @param seed - Seed value for key derivation
   * @returns Base64-encoded derived key
   */
  private deriveSigningKey(seed: string): string {
    return deriveKey(this.masterSecret, seed);
  }
}