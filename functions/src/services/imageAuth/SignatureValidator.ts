import { signData, deriveKey, verifySignature } from '../../utils/crypto.js';
import type { ImageSignature } from '../../models/ImageAuth.js';
import { logger } from '../../utils/logger.js';

/**
 * Service for parsing and validating HMAC signatures from image URLs
 */
export class SignatureValidator {
  constructor(private masterSecret: string) {}

  /**
   * Parse base64-encoded signature from query parameter
   * @param signatureParam - Base64-encoded signature from 'sig' query param
   * @returns Parsed signature or null if invalid
   */
  parseSignature(signatureParam: string): ImageSignature | null {
    try {
      // Decode base64
      const decoded = Buffer.from(signatureParam, 'base64url').toString('utf8');
      const data = JSON.parse(decoded);

      // Validate required fields
      if (
        !data.libraryId ||
        !data.photoId ||
        !data.size ||
        !data.format ||
        typeof data.expiresAt !== 'number'
      ) {
        logger.debug({ data }, 'Invalid signature: missing required fields');
        return null;
      }

      // Validate enum values
      if (!['original', 'small', 'medium', 'large'].includes(data.size)) {
        logger.debug({ size: data.size }, 'Invalid signature: invalid size');
        return null;
      }

      if (!['jpeg', 'webp'].includes(data.format)) {
        logger.debug({ format: data.format }, 'Invalid signature: invalid format');
        return null;
      }

      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      if (data.expiresAt <= now) {
        logger.debug(
          { expiresAt: data.expiresAt, now },
          'Invalid signature: expired'
        );
        return null;
      }

      // Must have either userId or shareToken
      if (!data.userId && !data.shareToken) {
        logger.debug('Invalid signature: missing userId and shareToken');
        return null;
      }

      return {
        libraryId: data.libraryId,
        photoId: data.photoId,
        size: data.size,
        format: data.format,
        expiresAt: data.expiresAt,
        userId: data.userId,
        shareToken: data.shareToken,
      };
    } catch (error) {
      logger.debug({ error }, 'Failed to parse signature');
      return null;
    }
  }

  /**
   * Validate HMAC signature against query parameters
   * 
   * Validates that the HMAC was generated using the user-level signing key
   * derived from the master secret and user identifier. This is single-level
   * validation with no photo-specific key derivation.
   * 
   * @param signature - Parsed signature data
   * @param queryParams - All query parameters from request  
   * @returns True if HMAC is valid
   */
  validateSignature(
    signature: ImageSignature,
    queryParams: Record<string, any>
  ): boolean {
    try {
      // Extract the HMAC from query params
      const providedHmac = queryParams.hmac;
      if (!providedHmac || typeof providedHmac !== 'string') {
        logger.debug('Missing or invalid HMAC in query parameters');
        return false;
      }

      // Reconstruct the canonical string that was signed
      const canonical = this.buildCanonicalString(
        signature.libraryId,
        signature.photoId,
        signature.size,
        signature.format,
        signature.expiresAt
      );

      // Derive the user-level signing key using the SAME method as SigningKeyService
      // deriveKey uses hex-decoded master secret, matching key generation
      const userIdentifier = signature.userId || signature.shareToken || 'anonymous';
      const userSigningKey = deriveKey(this.masterSecret, userIdentifier);

      // Verify HMAC using timing-safe comparison
      const isValid = verifySignature(userSigningKey, canonical, providedHmac);

      if (!isValid) {
        logger.warn(
          { 
            provided: providedHmac.substring(0, 16), 
            canonical: canonical.substring(0, 40),
            userIdentifier: userIdentifier.substring(0, 16) + '...'
          },
          'HMAC mismatch'
        );
      } else {
        logger.debug(
          {
            libraryId: signature.libraryId,
            photoId: signature.photoId,
          },
          'Signature validated successfully'
        );
      }

      return isValid;
    } catch (error) {
      logger.error({ error }, 'Error validating signature');
      return false;
    }
  }

  /**
   * Build canonical string from signature components
   * This must match the format used on the client side
   * @returns Canonical string for signing
   */
  private buildCanonicalString(
    libraryId: string,
    photoId: string,
    size: string,
    format: string,
    expiresAt: number
  ): string {
    return `${libraryId}:${photoId}:${size}:${format}:${expiresAt}`;
  }
}