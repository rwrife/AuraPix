/**
 * Frontend types for HMAC-signed URL authentication system
 */

/**
 * Signing key with client-side generation capabilities
 */
export interface ClientSigningKey {
  key: string;           // Base64-encoded HMAC key
  expiresAt: Date;       // When this key expires
  userId?: string;       // User ID if authenticated
  shareToken?: string;   // Share token if viewing shared content
}

/**
 * Parameters for generating a signed image URL
 */
export interface SignedUrlParams {
  libraryId: string;
  photoId: string;
  size?: 'original' | 'small' | 'medium' | 'large';
  format?: 'jpeg' | 'webp';
  expiresIn?: number;    // Seconds until URL expires (default: 600 = 10 min)
}

/**
 * Raw signing key response from backend API
 */
export interface SigningKeyResponse {
  key: string;           // Base64-encoded HMAC key
  expiresAt: string;     // ISO timestamp when this key expires
  userId?: string;       // User ID for authenticated requests
  shareToken?: string;   // Share token for public share requests
}