/**
 * Per-tenant webhook signing secret with optional rotation grace window.
 *
 * Outbound metering webhooks are signed via HMAC-SHA256 over the request
 * body and the signature is sent in `X-AuraPix-Signature`. When an operator
 * rotates the secret via the rotate endpoint (issue #161), we keep the
 * previous secret valid for a configurable grace window (default 24h, capped
 * at 7d) so receivers can validate either signature while they cut over.
 *
 * During the window the sink signs each delivery with BOTH secrets and
 * sends two comma-separated values (`v1=<new>,v1=<old>`).
 *
 * The plaintext secret is returned to the operator EXACTLY ONCE in the
 * rotate response and is never re-readable afterwards. Firestore stores
 * the plaintext (used by the sink to sign) plus a non-reversible
 * `fingerprint` (SHA-256 prefix) for audit / GET-metadata responses.
 *
 * Documents live at `tenantWebhookSecrets/{tenantId}`.
 */

export interface TenantWebhookSecretMaterial {
  /** Plaintext signing secret. Never returned by GET endpoints. */
  secret: string;
  /** SHA-256 hex prefix of `secret` — safe to surface in metadata. */
  fingerprint: string;
  /** ISO-8601 timestamp this secret was minted. */
  createdAt: string;
}

export interface TenantWebhookSecretRecord {
  /** Tenant the secret belongs to (also the Firestore doc id). */
  tenantId: string;
  /** Currently active signing material. */
  current: TenantWebhookSecretMaterial;
  /**
   * Previously active material, retained during the grace window. The sink
   * appends a signature for this secret alongside the current one until
   * `previousExpiresAt`. After expiry the field is dropped by the purge job.
   */
  previous?: TenantWebhookSecretMaterial;
  /**
   * ISO-8601 when the previous secret must stop being used. Present iff
   * `previous` is set.
   */
  previousExpiresAt?: string;
  /** ISO-8601 of the last rotation (or initial creation). */
  rotatedAt: string;
  /** ISO-8601 of the last write to this record. */
  updatedAt: string;
}

export const TENANT_WEBHOOK_SECRETS_COLLECTION = 'tenantWebhookSecrets';

/** Default grace window when none is supplied to a rotate call. */
export const DEFAULT_ROTATION_GRACE_SECONDS = 24 * 60 * 60;

/** Maximum grace window allowed (7 days). */
export const MAX_ROTATION_GRACE_SECONDS = 7 * 24 * 60 * 60;
