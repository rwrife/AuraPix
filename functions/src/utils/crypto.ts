import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Cryptographic utilities for HMAC-based signed URLs
 */

/**
 * Generate a random HMAC key
 * @returns Base64-encoded random key (32 bytes)
 */
export function generateHmacKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * Sign data using HMAC-SHA256
 * @param key - Base64-encoded HMAC key
 * @param data - Data to sign (will be converted to string if needed)
 * @returns Base64-encoded HMAC signature
 */
export function signData(key: string, data: string): string {
  const hmac = createHmac('sha256', Buffer.from(key, 'base64'));
  hmac.update(data);
  return hmac.digest('base64');
}

/**
 * Verify HMAC signature using timing-safe comparison
 * @param key - Base64-encoded HMAC key
 * @param data - Original data that was signed
 * @param signature - Base64-encoded signature to verify
 * @returns True if signature is valid
 */
export function verifySignature(key: string, data: string, signature: string): boolean {
  try {
    const expectedSignature = signData(key, data);
    const sigBuffer = Buffer.from(signature, 'base64');
    const expectedBuffer = Buffer.from(expectedSignature, 'base64');

    // Ensure buffers are same length for timing-safe comparison
    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    // Invalid base64 or other error
    return false;
  }
}

/**
 * Derive a signing key from a seed and master secret
 * Used to generate deterministic keys without storing them
 * @param masterSecret - Master secret for key derivation
 * @param seed - Seed value (e.g., userId or shareToken)
 * @returns Base64-encoded derived key
 */
export function deriveKey(masterSecret: string, seed: string): string {
  return signData(masterSecret, seed);
}