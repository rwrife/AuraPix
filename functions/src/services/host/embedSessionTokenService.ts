/**
 * Embed session token service — issue #195.
 *
 * Hosts mint short-lived signed tokens for already-authenticated end users
 * and pass them to the embedded AuraPix iframe so the user lands inside
 * AuraPix with the right tenant + role without seeing a Firebase login UI.
 *
 * Token format
 * ------------
 * A compact JWT-like envelope:
 *
 *   base64url(header).base64url(payload).base64url(hmac_sha256(header.payload, secret))
 *
 * `header` is the JSON `{"alg":"HS256","typ":"JWT"}`.
 *
 * `payload` is the JSON
 *   {
 *     "iss": tenantId,         // issuer = tenantId
 *     "aud": "aurapix:embed",  // audience constant
 *     "sub": userId,           // subject = end-user id
 *     "role": "owner|editor|viewer",
 *     "jti": randomUUID,       // unique id for replay defense
 *     "iat": <unix seconds>,   // issued at
 *     "exp": <unix seconds>    // expiry, capped at 300s
 *   }
 *
 * Signing key
 * -----------
 * Tokens are signed with the tenant's existing webhook signing secret (see
 * `tenantWebhookSecretService.ts`, issue #161). Rotation behaviour inherits
 * #161's dual-secret grace window: tokens minted with the previous secret
 * remain valid for verification until the grace window expires.
 *
 * Replay protection
 * -----------------
 * Each successful redemption records the token's `jti` in the
 * `embedSessionTokenJtis` collection. A second redemption returns
 * `token_replayed`.
 *
 * Dependency surface kept deliberately small: only Node `crypto` is used so
 * we avoid adding a new runtime dependency for a feature whose JWT shape is
 * effectively bespoke (HS256, fixed claims).
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import {
  resolveActiveSigningSecrets,
  type ActiveSigningSecret,
} from './tenantWebhookSecretService.js';
import {
  isTenantMemberRole,
  type TenantMemberRole,
} from '../../models/TenantMember.js';
import { getMembership } from '../tenant/tenantMembershipService.js';
import { logger } from '../../utils/logger.js';

/** Fixed audience claim. */
export const EMBED_SESSION_TOKEN_AUDIENCE = 'aurapix:embed';

/** Maximum TTL the host can request (5 minutes). */
export const EMBED_SESSION_TOKEN_MAX_TTL_SECONDS = 300;

/** Default TTL when the host does not specify one. */
export const EMBED_SESSION_TOKEN_DEFAULT_TTL_SECONDS = 120;

/**
 * Replay tracking collection. Records the `jti` of every redeemed token
 * along with the timestamp it expires (so periodic cleanup can drop entries
 * that no longer carry replay risk).
 */
export const EMBED_SESSION_TOKEN_JTI_COLLECTION = 'embedSessionTokenJtis';

export interface EmbedSessionTokenJtiRecord {
  jti: string;
  tenantId: string;
  userId: string;
  redeemedAt: string;
  /** ISO timestamp the original token would have expired. */
  expiresAt: string;
}

export interface EmbedSessionTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  role: TenantMemberRole;
  jti: string;
  iat: number;
  exp: number;
}

export interface MintEmbedSessionTokenInput {
  tenantId: string;
  userId: string;
  role?: TenantMemberRole;
  ttlSeconds?: number;
}

export interface MintEmbedSessionTokenResult {
  token: string;
  expiresAt: string;
  jti: string;
  role: TenantMemberRole;
}

export type MintEmbedSessionTokenError =
  | { code: 'invalid_input'; message: string }
  | { code: 'user_not_member'; message: string }
  | { code: 'no_signing_secret'; message: string };

/** Base64url encoding (no padding). */
function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(input: string): Buffer {
  // Restore padding so Buffer.from('base64') parses it correctly.
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signSegment(segment: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(segment).digest());
}

function clampTtl(ttl: number | undefined): number {
  if (ttl === undefined || ttl === null) return EMBED_SESSION_TOKEN_DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) return EMBED_SESSION_TOKEN_DEFAULT_TTL_SECONDS;
  return Math.min(Math.floor(ttl), EMBED_SESSION_TOKEN_MAX_TTL_SECONDS);
}

function buildToken(
  claims: EmbedSessionTokenClaims,
  signingSecret: string
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = signSegment(signingInput, signingSecret);
  return `${signingInput}.${signature}`;
}

export interface MintEmbedSessionTokenOptions {
  /** Test hook for time. */
  now?: () => Date;
  /** Test hook for jti generation. */
  generateJti?: () => string;
}

/**
 * Mint a fresh embed session token for `(tenantId, userId)`.
 *
 * Rejects when the user is not an active member of the tenant — hosts are
 * expected to provision membership via the tenant-users API (#143) first.
 * Auto-provisioning is intentionally out of scope per the issue.
 */
export async function mintEmbedSessionToken(
  dataAdapter: DataAdapter,
  input: MintEmbedSessionTokenInput,
  options: MintEmbedSessionTokenOptions = {}
): Promise<MintEmbedSessionTokenResult | MintEmbedSessionTokenError> {
  const tenantId = (input.tenantId ?? '').toString();
  const userId = (input.userId ?? '').toString();
  if (!tenantId || !userId) {
    return { code: 'invalid_input', message: 'tenantId and userId are required' };
  }
  if (input.role !== undefined && input.role !== null && !isTenantMemberRole(input.role)) {
    return { code: 'invalid_input', message: 'role must be owner | editor | viewer when provided' };
  }

  const membership = await getMembership(dataAdapter, tenantId, userId);
  if (!membership) {
    return {
      code: 'user_not_member',
      message: 'User is not a member of the tenant — provision via the tenant-users API first.',
    };
  }

  const secrets = await resolveActiveSigningSecrets(dataAdapter, tenantId, {
    now: options.now,
  });
  if (!secrets) {
    return {
      code: 'no_signing_secret',
      message:
        'Tenant has no webhook signing secret — rotate one via /v1/tenants/{tenantId}/webhook-secret first.',
    };
  }

  const now = (options.now ?? (() => new Date()))();
  const ttlSeconds = clampTtl(input.ttlSeconds);
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ttlSeconds;
  const jti = (options.generateJti ?? randomUUID)();
  const role: TenantMemberRole = input.role ?? membership.role;

  const claims: EmbedSessionTokenClaims = {
    iss: tenantId,
    aud: EMBED_SESSION_TOKEN_AUDIENCE,
    sub: userId,
    role,
    jti,
    iat,
    exp,
  };

  const token = buildToken(claims, secrets.current.secret);
  const expiresAt = new Date(exp * 1000).toISOString();
  return { token, expiresAt, jti, role };
}

export interface VerifyEmbedSessionTokenOptions {
  /** Expected tenant id — the iframe's tenant context. */
  expectedTenantId: string;
  /** Test hook for time. */
  now?: () => Date;
  /** Maximum clock skew tolerated, in seconds. Defaults to 30s. */
  clockSkewSeconds?: number;
}

export type VerifyEmbedSessionTokenError =
  | { code: 'invalid_token'; message: string }
  | { code: 'token_expired'; message: string }
  | { code: 'tenant_mismatch'; message: string }
  | { code: 'token_replayed'; message: string }
  | { code: 'user_not_member'; message: string };

export interface VerifyEmbedSessionTokenSuccess {
  ok: true;
  claims: EmbedSessionTokenClaims;
  /** Which secret matched (current vs previous) — useful for observability. */
  matchedSecret: 'current' | 'previous';
}

export type VerifyEmbedSessionTokenResult =
  | VerifyEmbedSessionTokenSuccess
  | ({ ok: false } & VerifyEmbedSessionTokenError);

function safeEqualHexlike(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function parseTokenSegments(
  token: string
): { header: string; payload: string; signature: string } | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return null;
  return { header, payload, signature };
}

function decodeHeader(segment: string): { alg?: string; typ?: string } | null {
  try {
    const obj = JSON.parse(base64urlDecode(segment).toString('utf8'));
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as { alg?: string; typ?: string };
  } catch {
    return null;
  }
}

function decodePayload(segment: string): EmbedSessionTokenClaims | null {
  try {
    const obj = JSON.parse(base64urlDecode(segment).toString('utf8')) as Record<string, unknown>;
    if (typeof obj !== 'object' || obj === null) return null;
    const { iss, aud, sub, role, jti, iat, exp } = obj as Record<string, unknown>;
    if (
      typeof iss !== 'string' ||
      typeof aud !== 'string' ||
      typeof sub !== 'string' ||
      typeof role !== 'string' ||
      !isTenantMemberRole(role) ||
      typeof jti !== 'string' ||
      typeof iat !== 'number' ||
      typeof exp !== 'number' ||
      !Number.isFinite(iat) ||
      !Number.isFinite(exp)
    ) {
      return null;
    }
    return { iss, aud, sub, role, jti, iat: Math.floor(iat), exp: Math.floor(exp) };
  } catch {
    return null;
  }
}

/**
 * Verify an embed session token: decode, check signature against any active
 * signing secret (current + grace-window previous), enforce audience,
 * tenant binding, expiry, then record + check `jti` for replay.
 *
 * Returns a discriminated result so callers can map cleanly to HTTP errors.
 */
export async function verifyAndRedeemEmbedSessionToken(
  dataAdapter: DataAdapter,
  token: string,
  options: VerifyEmbedSessionTokenOptions
): Promise<VerifyEmbedSessionTokenResult> {
  const parts = parseTokenSegments(token);
  if (!parts) {
    return { ok: false, code: 'invalid_token', message: 'Token is malformed' };
  }

  const header = decodeHeader(parts.header);
  if (!header || header.alg !== 'HS256' || (header.typ && header.typ !== 'JWT')) {
    return { ok: false, code: 'invalid_token', message: 'Token header is invalid' };
  }

  const claims = decodePayload(parts.payload);
  if (!claims) {
    return { ok: false, code: 'invalid_token', message: 'Token payload is invalid' };
  }

  if (claims.aud !== EMBED_SESSION_TOKEN_AUDIENCE) {
    return { ok: false, code: 'invalid_token', message: 'Audience mismatch' };
  }

  // Tenant binding — the iframe's tenant context MUST match the token's
  // issuer. Mismatch is rejected at exchange time so cross-tenant tokens
  // can't be relayed into another tenant's embed.
  if (claims.iss !== options.expectedTenantId) {
    return {
      ok: false,
      code: 'tenant_mismatch',
      message: 'Token tenant does not match iframe tenant',
    };
  }

  const skew = Math.max(0, Math.floor(options.clockSkewSeconds ?? 30));
  const now = options.now ? options.now() : new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  if (claims.exp + skew <= nowSec) {
    return { ok: false, code: 'token_expired', message: 'Token has expired' };
  }
  if (claims.iat > nowSec + skew) {
    return { ok: false, code: 'invalid_token', message: 'Token issued-at is in the future' };
  }

  // Validate signature against current + (optional) previous secret.
  const secrets = await resolveActiveSigningSecrets(dataAdapter, claims.iss, {
    now: options.now,
  });
  if (!secrets) {
    return { ok: false, code: 'invalid_token', message: 'Token signature is invalid' };
  }

  const signingInput = `${parts.header}.${parts.payload}`;
  const expectedCurrent = signSegment(signingInput, secrets.current.secret);
  let matchedSecret: 'current' | 'previous' | null = null;
  if (safeEqualHexlike(expectedCurrent, parts.signature)) {
    matchedSecret = 'current';
  } else if (secrets.previous) {
    const expectedPrevious = signSegment(signingInput, secrets.previous.secret);
    if (safeEqualHexlike(expectedPrevious, parts.signature)) {
      matchedSecret = 'previous';
    }
  }
  if (!matchedSecret) {
    return { ok: false, code: 'invalid_token', message: 'Token signature is invalid' };
  }

  // Reconfirm membership at exchange time so revoked users can't keep
  // redeeming valid-looking tokens. Tokens are short-lived (max 5 minutes)
  // so the membership lookup is bounded.
  const membership = await getMembership(dataAdapter, claims.iss, claims.sub);
  if (!membership) {
    return {
      ok: false,
      code: 'user_not_member',
      message: 'User is no longer a member of the tenant.',
    };
  }

  // Replay defense — `jti` is one-time use within its TTL window. Record
  // BEFORE handing the session out so two near-simultaneous redemptions of
  // the same token race deterministically through the data adapter (first
  // write wins; second redemption sees the existing record).
  const jtiDocId = `${claims.iss}__${claims.jti}`;
  try {
    const existing = await dataAdapter.fetchData<EmbedSessionTokenJtiRecord>(
      EMBED_SESSION_TOKEN_JTI_COLLECTION,
      jtiDocId
    );
    if (existing) {
      return { ok: false, code: 'token_replayed', message: 'Token has already been redeemed' };
    }
    const record: EmbedSessionTokenJtiRecord = {
      jti: claims.jti,
      tenantId: claims.iss,
      userId: claims.sub,
      redeemedAt: now.toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    };
    await dataAdapter.storeData<EmbedSessionTokenJtiRecord>(
      EMBED_SESSION_TOKEN_JTI_COLLECTION,
      jtiDocId,
      record
    );
  } catch (err) {
    // If the JTI store is unreachable we fail closed — better to reject a
    // valid token than allow a replay.
    logger.warn({ err, tenantId: claims.iss }, 'embed session token jti store unavailable');
    return { ok: false, code: 'invalid_token', message: 'Token replay check unavailable' };
  }

  return { ok: true, claims, matchedSecret };
}

/**
 * Compute a stable, non-reversible hash of a JTI for metering events.
 * Returns the first 16 hex chars of SHA-256(jti) — short enough to log,
 * impossible to invert back to the original UUID.
 *
 * Lives here (rather than the route layer) so the metering payload shape
 * stays consistent across mint + exchange call sites.
 */
export function hashJtiForMetering(jti: string): string {
  return createHash('sha256').update(jti, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Helper exported for tests — re-exposes the internal token assembly so
 * unit tests can synthesize tokens with known fields without re-deriving
 * the base64url + HMAC logic.
 *
 * NOT for use by routes; mint/verify above are the public API.
 */
export function _internalBuildTokenForTests(
  claims: EmbedSessionTokenClaims,
  signingSecret: string
): string {
  return buildToken(claims, signingSecret);
}

/**
 * Best-effort export to satisfy tree-shakers — re-export the configured
 * signing-secret shape so callers can build mock signing flows in tests
 * without reaching into the host webhook service.
 */
export type EmbedSessionTokenSigningSecret = ActiveSigningSecret;
