#!/usr/bin/env node

/**
 * Generate a cryptographically secure signing secret for HMAC-signed URLs
 * 
 * Usage:
 *   node generate-signing-secret.mjs
 *   
 * This script generates a 256-bit (32-byte) random secret encoded as hexadecimal.
 * The secret should be stored securely in your deployment environment variables.
 */

import { randomBytes } from 'crypto';

function generateSigningSecret() {
  // Generate 32 bytes (256 bits) of cryptographically secure random data
  const secret = randomBytes(32).toString('hex');
  return secret;
}

// Main execution
const secret = generateSigningSecret();

console.log('='.repeat(80));
console.log('Generated Signing Secret for HMAC URL Signatures');
console.log('='.repeat(80));
console.log('');
console.log('Secret (hex):');
console.log(secret);
console.log('');
console.log('Length:', secret.length, 'characters (', secret.length / 2, 'bytes)');
console.log('');
console.log('='.repeat(80));
console.log('IMPORTANT: Store this secret securely!');
console.log('='.repeat(80));
console.log('');
console.log('For Cloud Run deployment, set as environment variable:');
console.log('  gcloud run services update aurapix-api \\');
console.log('    --region us-central1 \\');
console.log('    --update-env-vars SIGNING_MASTER_SECRET=' + secret);
console.log('');
console.log('For Firebase Functions, add to .env file (DO NOT commit):');
console.log('  SIGNING_MASTER_SECRET=' + secret);
console.log('');
console.log('For local development, add to aurapix/functions/.env:');
console.log('  SIGNING_MASTER_SECRET=' + secret);
console.log('');
console.log('='.repeat(80));

export { generateSigningSecret };