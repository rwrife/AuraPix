/**
 * Per-tenant webhook signing secret management (issue #161).
 *
 * - `rotateTenantWebhookSecret` mints a fresh secret, promotes the existing
 *   `current` to `previous` (kept valid for the grace window), and returns
 *   the new plaintext exactly once.
 * - `getTenantWebhookSecretMetadata` returns audit metadata only (created
 *   timestamps + fingerprints) — never the plaintext secret.
 * - `resolveActiveSigningSecrets` returns the secrets the sink should use
 *   right now (current + maybe previous if we're still inside the grace
 *   window). Used by `HostWebhookSink` for dual-sign during rotation.
 * - `purgeExpiredPreviousSecrets` removes any expired `previous` material
 *   across all tenants; runs from a scheduled job.
 *
 * Secrets are stored in plaintext (the sink needs them to HMAC outbound
 * bodies). The collection inherits Firestore's project-level encryption at
 * rest; access should be locked down via security rules / IAM. Fingerprints
 * are SHA-256 prefixes so we can surface stable identifiers without
 * revealing the secret itself.
 */

import { createHash, randomBytes } from 'crypto';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import {
  DEFAULT_ROTATION_GRACE_SECONDS,
  MAX_ROTATION_GRACE_SECONDS,
  TENANT_WEBHOOK_SECRETS_COLLECTION,
  type TenantWebhookSecretMaterial,
  type TenantWebhookSecretRecord,
} from '../../models/TenantWebhookSecret.js';

export const WEBHOOK_SECRET_PREFIX = 'whsec_';
/** Length (chars) of the truncated SHA-256 used as a stable fingerprint. */
export const FINGERPRINT_LENGTH = 16;

/**
 * Generate a fresh plaintext webhook signing secret.
 *
 * 32 random bytes encoded as base64url (~43 chars after the `whsec_` prefix)
 * which exceeds 256 bits of entropy — comparable to commonly recommended
 * webhook secrets (e.g. Stripe).
 */
export function generateWebhookSecret(): string {
  const random = randomBytes(32).toString('base64url');
  return `${WEBHOOK_SECRET_PREFIX}${random}`;
}

/** Compute the fingerprint (truncated SHA-256 hex) for a plaintext secret. */
export function computeSecretFingerprint(secret: string): string {
  return createHash('sha256')
    .update(secret, 'utf8')
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
}

function clampGraceWindow(graceSeconds: number | undefined): number {
  if (graceSeconds === undefined || graceSeconds === null) {
    return DEFAULT_ROTATION_GRACE_SECONDS;
  }
  if (!Number.isFinite(graceSeconds) || graceSeconds < 0) {
    return DEFAULT_ROTATION_GRACE_SECONDS;
  }
  return Math.min(Math.floor(graceSeconds), MAX_ROTATION_GRACE_SECONDS);
}

function buildMaterial(now: Date, plaintext?: string): TenantWebhookSecretMaterial {
  const secret = plaintext ?? generateWebhookSecret();
  return {
    secret,
    fingerprint: computeSecretFingerprint(secret),
    createdAt: now.toISOString(),
  };
}

export interface RotateTenantWebhookSecretOptions {
  /** Grace window seconds (default 24h, capped at 7d). */
  graceSeconds?: number;
  /** Test hook for time. */
  now?: () => Date;
  /**
   * Inject a deterministic plaintext (tests only). Production callers MUST
   * NOT pass this — the secret should always be randomly generated.
   */
  plaintextSecret?: string;
}

export interface RotateTenantWebhookSecretResult {
  /** Stored record after the rotation. */
  record: TenantWebhookSecretRecord;
  /**
   * Plaintext value of the new (`current`) secret. Returned exactly once;
   * callers MUST surface it to the operator and then drop the value.
   */
  plaintextSecret: string;
  /** ISO-8601 timestamp the old secret expires. Equals current.createdAt when
   * there was no prior secret (no rotation actually performed; fresh mint). */
  rotatesAt: string;
}

/**
 * Public-facing metadata about a tenant webhook secret. Excludes plaintext.
 */
export interface TenantWebhookSecretMetadata {
  tenantId: string;
  /** ISO-8601 when the current secret was minted. */
  createdAt: string;
  /** Stable fingerprint of the current secret. */
  fingerprint: string;
  /** ISO-8601 of the last rotation event. */
  rotatedAt: string;
  /**
   * Metadata for the previous (still-valid) secret, when a rotation grace
   * window is active.
   */
  previous?: {
    createdAt: string;
    fingerprint: string;
    /** ISO-8601 when the previous secret stops being used. */
    expiresAt: string;
  };
}

/**
 * Rotate (or initially mint) a tenant's webhook signing secret.
 *
 * - If no record exists yet, creates one with `current` set and no `previous`.
 * - Otherwise promotes the existing `current` to `previous` with a grace
 *   window (default 24h, capped at 7d) and mints a new `current`.
 *
 * Returns the new plaintext secret; this is the ONLY chance the operator
 * has to capture it.
 */
export async function rotateTenantWebhookSecret(
  dataAdapter: DataAdapter,
  tenantId: string,
  options: RotateTenantWebhookSecretOptions = {}
): Promise<RotateTenantWebhookSecretResult> {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenantId is required');
  }
  const now = (options.now ?? (() => new Date()))();
  const graceSeconds = clampGraceWindow(options.graceSeconds);

  const existing = await dataAdapter.fetchData<TenantWebhookSecretRecord>(
    TENANT_WEBHOOK_SECRETS_COLLECTION,
    tenantId
  );

  const newMaterial = buildMaterial(now, options.plaintextSecret);
  const nowIso = now.toISOString();

  let record: TenantWebhookSecretRecord;
  let rotatesAt: string;
  if (!existing) {
    // Initial mint — no previous secret to dual-sign with.
    record = {
      tenantId,
      current: newMaterial,
      rotatedAt: nowIso,
      updatedAt: nowIso,
    };
    rotatesAt = newMaterial.createdAt;
  } else {
    const previousExpiresAt = new Date(
      now.getTime() + graceSeconds * 1000
    ).toISOString();
    record = {
      tenantId,
      current: newMaterial,
      previous: existing.current,
      previousExpiresAt,
      rotatedAt: nowIso,
      updatedAt: nowIso,
    };
    rotatesAt = previousExpiresAt;
  }

  await dataAdapter.storeData(
    TENANT_WEBHOOK_SECRETS_COLLECTION,
    tenantId,
    record
  );

  return {
    record,
    plaintextSecret: newMaterial.secret,
    rotatesAt,
  };
}

/**
 * Return public metadata about a tenant's webhook secret, or null if no
 * secret has been minted yet. Plaintext is never exposed.
 */
export async function getTenantWebhookSecretMetadata(
  dataAdapter: DataAdapter,
  tenantId: string,
  options: { now?: () => Date } = {}
): Promise<TenantWebhookSecretMetadata | null> {
  const record = await dataAdapter.fetchData<TenantWebhookSecretRecord>(
    TENANT_WEBHOOK_SECRETS_COLLECTION,
    tenantId
  );
  if (!record) return null;
  const now = (options.now ?? (() => new Date()))();
  const meta: TenantWebhookSecretMetadata = {
    tenantId: record.tenantId,
    createdAt: record.current.createdAt,
    fingerprint: record.current.fingerprint,
    rotatedAt: record.rotatedAt,
  };
  if (record.previous && record.previousExpiresAt) {
    // Hide expired previous data from callers; the purge job will clean it
    // up on its own cadence, but the metadata view should not advertise
    // secrets that are no longer in use.
    if (new Date(record.previousExpiresAt).getTime() > now.getTime()) {
      meta.previous = {
        createdAt: record.previous.createdAt,
        fingerprint: record.previous.fingerprint,
        expiresAt: record.previousExpiresAt,
      };
    }
  }
  return meta;
}

export interface ActiveSigningSecret {
  /** Plaintext used for HMAC. */
  secret: string;
  /** Stable fingerprint of the secret — surfaced on delivery records. */
  fingerprint: string;
}

export interface ResolvedSigningSecrets {
  /** Currently active secret used for HMAC signing. */
  current: ActiveSigningSecret;
  /**
   * Optional previous secret. Present only inside the rotation grace
   * window — the sink emits an additional signature for it so receivers
   * can verify with either secret.
   */
  previous?: ActiveSigningSecret;
}

/**
 * Resolve which signing secret(s) the sink should use for a tenant right
 * now. Inside the grace window both secrets are returned. Returns null
 * when no per-tenant secret has been minted yet (caller should fall back
 * to a process-wide secret).
 */
export async function resolveActiveSigningSecrets(
  dataAdapter: DataAdapter,
  tenantId: string,
  options: { now?: () => Date } = {}
): Promise<ResolvedSigningSecrets | null> {
  const record = await dataAdapter.fetchData<TenantWebhookSecretRecord>(
    TENANT_WEBHOOK_SECRETS_COLLECTION,
    tenantId
  );
  if (!record) return null;
  const now = (options.now ?? (() => new Date()))();
  const result: ResolvedSigningSecrets = {
    current: {
      secret: record.current.secret,
      fingerprint: record.current.fingerprint,
    },
  };
  if (
    record.previous &&
    record.previousExpiresAt &&
    new Date(record.previousExpiresAt).getTime() > now.getTime()
  ) {
    result.previous = {
      secret: record.previous.secret,
      fingerprint: record.previous.fingerprint,
    };
  }
  return result;
}

export interface PurgeExpiredSecretsResult {
  /** Tenants whose `previous` material was dropped. */
  tenantIds: string[];
}

/**
 * Scheduled-job entry point: drop every `previous` secret whose grace
 * window has elapsed. Safe to call repeatedly.
 */
export async function purgeExpiredPreviousSecrets(
  dataAdapter: DataAdapter,
  options: { now?: () => Date } = {}
): Promise<PurgeExpiredSecretsResult> {
  const now = (options.now ?? (() => new Date()))();
  const ids = await dataAdapter.listIds(TENANT_WEBHOOK_SECRETS_COLLECTION);
  const purged: string[] = [];
  for (const id of ids) {
    const record = await dataAdapter.fetchData<TenantWebhookSecretRecord>(
      TENANT_WEBHOOK_SECRETS_COLLECTION,
      id
    );
    if (!record || !record.previous || !record.previousExpiresAt) continue;
    if (new Date(record.previousExpiresAt).getTime() > now.getTime()) continue;
    const nextRecord: TenantWebhookSecretRecord = {
      tenantId: record.tenantId,
      current: record.current,
      rotatedAt: record.rotatedAt,
      updatedAt: now.toISOString(),
    };
    await dataAdapter.storeData(
      TENANT_WEBHOOK_SECRETS_COLLECTION,
      id,
      nextRecord
    );
    purged.push(id);
  }
  return { tenantIds: purged };
}
