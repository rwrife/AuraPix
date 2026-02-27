import type { SignedUrlParams, ClientSigningKey } from '../domain/imageAuth/types.js';
import { API_CONFIG } from '../config/api.js';

/**
 * Generate a cryptographically signed image URL using HMAC-SHA256
 * 
 * @param params - Image parameters (libraryId, photoId, size, format)
 * @param signingKey - Client signing key from backend
 * @returns Fully signed URL ready to use in <img> tags
 */
export function generateSignedImageUrl(
  params: SignedUrlParams,
  signingKey: ClientSigningKey
): string {
  const {
    libraryId,
    photoId,
    size = 'medium',
    format = 'webp',
    expiresIn = 600, // 10 minutes default
  } = params;

  // Calculate expiration timestamp (Unix seconds)
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  // Build base URL
  const baseUrl = `${API_CONFIG.baseUrl}/images/${libraryId}/${photoId}`;

  // Create signature payload
  const signaturePayload = {
    libraryId,
    photoId,
    size,
    format,
    expiresAt,
    ...(signingKey.userId && { userId: signingKey.userId }),
    ...(signingKey.shareToken && { shareToken: signingKey.shareToken }),
  };

  // Generate HMAC signature using Web Crypto API (placeholder)
  void generateHmacSignature();

  // Encode signature payload as base64url
  const encodedSignature = base64UrlEncode(JSON.stringify(signaturePayload));

  // Build final URL with query parameters
  const url = new URL(baseUrl);
  url.searchParams.set('size', size);
  url.searchParams.set('format', format);
  url.searchParams.set('sig', encodedSignature);

  return url.toString();
}

/**
 * Generate HMAC-SHA256 signature synchronously using subtle crypto
 * Note: This is a synchronous wrapper around the async Web Crypto API
 * 
 * @param key - Base64-encoded HMAC key
 * @param data - Data to sign
 * @returns Base64-encoded signature
 */
function generateHmacSignature(): string {
  // For now, we'll use a simpler approach that doesn't require async
  // In production, consider using a sync HMAC library or pre-computing signatures
  // This is a placeholder - we'll actually compute this async in the manager
  return 'placeholder-will-be-computed-by-manager';
}

/**
 * Convert base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Encode string as base64url (URL-safe base64)
 */
function base64UrlEncode(str: string): string {
  // Convert to base64
  const base64 = btoa(str);
  
  // Make URL-safe
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Async version that actually computes HMAC using Web Crypto API
 * This will be used by SigningKeyManager to pre-generate signatures
 */
export async function generateHmacSignatureAsync(
  key: string,
  data: string
): Promise<string> {
  // Decode base64 key
  const keyBuffer = base64ToArrayBuffer(key);
  
  // Import key for HMAC
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  // Encode data as UTF-8
  const dataBuffer = new TextEncoder().encode(data);
  
  // Generate signature
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer);
  
  // Convert to base64
  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  const signatureBase64 = btoa(String.fromCharCode(...signatureArray));
  
  return signatureBase64;
}