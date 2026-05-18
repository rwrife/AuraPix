import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import {
  TENANT_API_KEYS_COLLECTION,
  TENANT_API_KEY_PREFIX,
  TENANT_API_KEY_PREFIX_INDEX_LENGTH,
  TENANT_API_KEY_SCOPES,
  type TenantApiKeyRecord,
  type TenantApiKeyScope,
} from '../../models/TenantApiKey.js';

export interface CreatedTenantApiKey {
  record: TenantApiKeyRecord;
  /** Plaintext secret. Returned exactly once to the admin caller. */
  plaintextSecret: string;
}

/**
 * SHA-256 hash of a plaintext key, hex-encoded.
 */
export function hashSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Constant-time compare for two hex-encoded SHA-256 digests. Returns false on
 * length mismatch (rather than throwing) so callers can treat it as a simple
 * boolean predicate.
 */
export function constantTimeHashCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Validates that all provided scopes are recognized.
 */
export function validateScopes(scopes: unknown): TenantApiKeyScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('scopes must be a non-empty array');
  }
  const allowed = new Set<string>(TENANT_API_KEY_SCOPES);
  const out: TenantApiKeyScope[] = [];
  for (const s of scopes) {
    if (typeof s !== 'string' || !allowed.has(s)) {
      throw new Error(`Unknown scope: ${String(s)}`);
    }
    out.push(s as TenantApiKeyScope);
  }
  return Array.from(new Set(out));
}

/**
 * Generates a fresh plaintext key. 32 random bytes encoded as base64url, giving
 * ~43 chars of entropy after the `ak_live_` prefix.
 */
export function generatePlaintextKey(): string {
  const random = randomBytes(32).toString('base64url');
  return `${TENANT_API_KEY_PREFIX}${random}`;
}

/**
 * Extract the lookup prefix from a full plaintext key. Returns null when the
 * input is too short or does not match the expected key format.
 */
export function extractKeyPrefix(plaintext: string): string | null {
  if (typeof plaintext !== 'string') return null;
  if (!plaintext.startsWith(TENANT_API_KEY_PREFIX)) return null;
  if (plaintext.length < TENANT_API_KEY_PREFIX_INDEX_LENGTH) return null;
  return plaintext.slice(0, TENANT_API_KEY_PREFIX_INDEX_LENGTH);
}

/**
 * Persist a new tenant API key. Returns the stored record along with the
 * plaintext secret, which the caller MUST show to the admin exactly once.
 */
export async function createTenantApiKey(
  dataAdapter: DataAdapter,
  options: { tenantId: string; scopes: TenantApiKeyScope[]; label?: string }
): Promise<CreatedTenantApiKey> {
  const { tenantId, scopes, label } = options;
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenantId is required');
  }
  const plaintextSecret = generatePlaintextKey();
  const keyPrefix = extractKeyPrefix(plaintextSecret);
  if (!keyPrefix) {
    // Should be unreachable: generatePlaintextKey always produces a valid key.
    throw new Error('Failed to derive key prefix');
  }
  const id = `tak_${randomBytes(12).toString('base64url')}`;
  const now = new Date().toISOString();
  const record: TenantApiKeyRecord = {
    id,
    tenantId,
    keyPrefix,
    hashedSecret: hashSecret(plaintextSecret),
    scopes,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
    ...(label ? { label } : {}),
  };
  await dataAdapter.storeData(TENANT_API_KEYS_COLLECTION, id, record);
  return { record, plaintextSecret };
}

export async function listTenantApiKeys(
  dataAdapter: DataAdapter,
  tenantId: string
): Promise<TenantApiKeyRecord[]> {
  return dataAdapter.queryData<TenantApiKeyRecord>(TENANT_API_KEYS_COLLECTION, [
    { field: 'tenantId', operator: '==', value: tenantId },
  ]);
}

export async function revokeTenantApiKey(
  dataAdapter: DataAdapter,
  tenantId: string,
  keyId: string
): Promise<TenantApiKeyRecord | null> {
  const existing = await dataAdapter.fetchData<TenantApiKeyRecord>(
    TENANT_API_KEYS_COLLECTION,
    keyId
  );
  if (!existing) return null;
  if (existing.tenantId !== tenantId) {
    // Don't leak whether the key exists under a different tenant.
    return null;
  }
  if (existing.revokedAt) return existing;
  const revokedAt = new Date().toISOString();
  await dataAdapter.updateData<TenantApiKeyRecord>(
    TENANT_API_KEYS_COLLECTION,
    keyId,
    { revokedAt }
  );
  return { ...existing, revokedAt };
}

export interface AuthenticatedTenantKey {
  record: TenantApiKeyRecord;
}

/**
 * Look up a key by prefix and verify the full plaintext against the stored
 * hash. Returns the record on success, or null if no active key matches.
 */
export async function authenticatePlaintextKey(
  dataAdapter: DataAdapter,
  plaintext: string
): Promise<AuthenticatedTenantKey | null> {
  const prefix = extractKeyPrefix(plaintext);
  if (!prefix) return null;
  const candidates = await dataAdapter.queryData<TenantApiKeyRecord>(
    TENANT_API_KEYS_COLLECTION,
    [{ field: 'keyPrefix', operator: '==', value: prefix }]
  );
  if (!candidates || candidates.length === 0) return null;
  const presented = hashSecret(plaintext);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.hashedSecret !== 'string') continue;
    if (!constantTimeHashCompare(presented, candidate.hashedSecret)) continue;
    if (candidate.revokedAt) return null;
    return { record: candidate };
  }
  return null;
}

/**
 * Update lastUsedAt for an authenticated key. Best-effort: failures are
 * intentionally swallowed by the caller so a transient write error does not
 * block a valid request.
 */
export async function touchTenantApiKey(
  dataAdapter: DataAdapter,
  keyId: string
): Promise<void> {
  await dataAdapter.updateData<TenantApiKeyRecord>(
    TENANT_API_KEYS_COLLECTION,
    keyId,
    { lastUsedAt: new Date().toISOString() }
  );
}

/**
 * Strip sensitive fields before returning a key record to an admin caller.
 */
export function redactTenantApiKey(
  record: TenantApiKeyRecord
): Omit<TenantApiKeyRecord, 'hashedSecret'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { hashedSecret: _hashed, ...rest } = record;
  return rest;
}
