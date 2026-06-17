/**
 * Unit tests for `tenantWebhookSecretService` (issue #161).
 *
 * Covers:
 *   - rotate (initial mint + subsequent rotation with grace window)
 *   - resolveActiveSigningSecrets (dual-sign window + post-expiry single-secret)
 *   - getTenantWebhookSecretMetadata (no plaintext leak)
 *   - purgeExpiredPreviousSecrets (idempotent + only purges expired)
 *   - grace-window clamping (default + 7-day cap)
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { LocalJsonData } from '../../adapters/data/LocalJsonData.js';
import {
  computeSecretFingerprint,
  generateWebhookSecret,
  getTenantWebhookSecretMetadata,
  purgeExpiredPreviousSecrets,
  resolveActiveSigningSecrets,
  rotateTenantWebhookSecret,
  FINGERPRINT_LENGTH,
  WEBHOOK_SECRET_PREFIX,
} from './tenantWebhookSecretService.js';
import {
  DEFAULT_ROTATION_GRACE_SECONDS,
  MAX_ROTATION_GRACE_SECONDS,
  TENANT_WEBHOOK_SECRETS_COLLECTION,
  type TenantWebhookSecretRecord,
} from '../../models/TenantWebhookSecret.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function freshAdapter(): LocalJsonData {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-secret-test-'));
  // Tests intentionally leak the temp dir; the OS will clean it up.
  // We could wire afterEach cleanup, but keeping the API surface narrow.
  return new LocalJsonData(dir);
}

describe('generateWebhookSecret', () => {
  it('produces a base64url secret prefixed with whsec_', () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    // base64url of 32 bytes => 43 chars (no padding)
    expect(secret.length).toBe(WEBHOOK_SECRET_PREFIX.length + 43);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]+$/);
  });

  it('produces a distinct value on each call', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
  });
});

describe('computeSecretFingerprint', () => {
  it('returns a stable, truncated SHA-256 hex prefix', () => {
    const fp = computeSecretFingerprint('whsec_test_payload');
    expect(fp.length).toBe(FINGERPRINT_LENGTH);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    // Stable across calls.
    expect(computeSecretFingerprint('whsec_test_payload')).toBe(fp);
  });

  it('changes when the input changes', () => {
    const a = computeSecretFingerprint('whsec_a');
    const b = computeSecretFingerprint('whsec_b');
    expect(a).not.toBe(b);
  });
});

describe('rotateTenantWebhookSecret', () => {
  let adapter: LocalJsonData;
  beforeEach(() => {
    adapter = freshAdapter();
  });

  it('mints an initial secret with no previous material', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const result = await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => now,
    });
    expect(result.plaintextSecret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(result.record.current.secret).toBe(result.plaintextSecret);
    expect(result.record.previous).toBeUndefined();
    expect(result.record.previousExpiresAt).toBeUndefined();
    expect(result.record.rotatedAt).toBe(now.toISOString());
    // rotatesAt on initial mint is just the current.createdAt (no grace window).
    expect(result.rotatesAt).toBe(now.toISOString());
  });

  it('promotes current to previous on rotation and applies the default grace window', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-02T00:00:00.000Z');
    const initial = await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => t0,
    });
    const rotated = await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => t1,
    });

    expect(rotated.plaintextSecret).not.toBe(initial.plaintextSecret);
    expect(rotated.record.previous?.secret).toBe(initial.plaintextSecret);
    expect(rotated.record.previous?.fingerprint).toBe(
      initial.record.current.fingerprint
    );
    expect(rotated.record.previousExpiresAt).toBe(
      new Date(
        t1.getTime() + DEFAULT_ROTATION_GRACE_SECONDS * 1000
      ).toISOString()
    );
    expect(rotated.rotatesAt).toBe(rotated.record.previousExpiresAt);
  });

  it('clamps overly-large grace windows to the 7-day cap', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-02T00:00:00.000Z');
    await rotateTenantWebhookSecret(adapter, 'tenant-A', { now: () => t0 });
    const rotated = await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => t1,
      // Caller asks for 30 days; service must clamp to 7 days.
      graceSeconds: 30 * 24 * 60 * 60,
    });
    expect(rotated.record.previousExpiresAt).toBe(
      new Date(
        t1.getTime() + MAX_ROTATION_GRACE_SECONDS * 1000
      ).toISOString()
    );
  });

  it('treats negative or non-finite grace windows as the default', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-02T00:00:00.000Z');
    await rotateTenantWebhookSecret(adapter, 'tenant-A', { now: () => t0 });
    const rotated = await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => t1,
      graceSeconds: -5,
    });
    expect(rotated.record.previousExpiresAt).toBe(
      new Date(
        t1.getTime() + DEFAULT_ROTATION_GRACE_SECONDS * 1000
      ).toISOString()
    );
  });

  it('rejects empty tenantId', async () => {
    await expect(
      // @ts-expect-error intentional bad input
      rotateTenantWebhookSecret(adapter, '', {})
    ).rejects.toThrow(/tenantId/);
  });
});

describe('resolveActiveSigningSecrets', () => {
  it('returns null when no secret exists', async () => {
    const adapter = freshAdapter();
    const out = await resolveActiveSigningSecrets(adapter, 'tenant-missing');
    expect(out).toBeNull();
  });

  it('returns only the current secret on initial mint', async () => {
    const adapter = freshAdapter();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const r = await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => t0,
    });
    const out = await resolveActiveSigningSecrets(adapter, 'tenant-A', {
      now: () => t0,
    });
    expect(out).not.toBeNull();
    expect(out!.current.secret).toBe(r.plaintextSecret);
    expect(out!.current.fingerprint).toBe(r.record.current.fingerprint);
    expect(out!.previous).toBeUndefined();
  });

  it('returns BOTH secrets while inside the grace window (dual-sign)', async () => {
    const adapter = freshAdapter();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-02T00:00:00.000Z');
    const initial = await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => t0,
    });
    const rotated = await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => t1,
    });
    // Two minutes after rotation -> inside the window.
    const observe = new Date(t1.getTime() + 2 * 60 * 1000);
    const out = await resolveActiveSigningSecrets(adapter, 'tenant-A', {
      now: () => observe,
    });
    expect(out!.current.secret).toBe(rotated.plaintextSecret);
    expect(out!.previous).toBeDefined();
    expect(out!.previous!.secret).toBe(initial.plaintextSecret);
    expect(out!.previous!.fingerprint).toBe(initial.record.current.fingerprint);
  });

  it('drops the previous secret once the grace window has elapsed', async () => {
    const adapter = freshAdapter();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-02T00:00:00.000Z');
    await rotateTenantWebhookSecret(adapter, 'tenant-A', { now: () => t0 });
    await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => t1,
      graceSeconds: 60, // 60s for the test
    });
    // 2 minutes later -> past the window.
    const observe = new Date(t1.getTime() + 2 * 60 * 1000);
    const out = await resolveActiveSigningSecrets(adapter, 'tenant-A', {
      now: () => observe,
    });
    expect(out!.previous).toBeUndefined();
  });
});

describe('getTenantWebhookSecretMetadata', () => {
  it('returns null when no secret exists', async () => {
    const adapter = freshAdapter();
    const meta = await getTenantWebhookSecretMetadata(
      adapter,
      'tenant-missing'
    );
    expect(meta).toBeNull();
  });

  it('never returns the plaintext secret', async () => {
    const adapter = freshAdapter();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-02T00:00:00.000Z');
    await rotateTenantWebhookSecret(adapter, 'tenant-A', { now: () => t0 });
    await rotateTenantWebhookSecret(adapter, 'tenant-A', { now: () => t1 });
    const meta = await getTenantWebhookSecretMetadata(adapter, 'tenant-A', {
      now: () => t1,
    });
    // Crude check: no top-level field equals a plaintext-style secret.
    const blob = JSON.stringify(meta);
    expect(blob).not.toMatch(/whsec_/);
    expect(meta!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(meta!.previous?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(meta!.previous?.expiresAt).toBeDefined();
  });

  it('hides expired previous metadata even before the purge job runs', async () => {
    const adapter = freshAdapter();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-02T00:00:00.000Z');
    await rotateTenantWebhookSecret(adapter, 'tenant-A', { now: () => t0 });
    await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => t1,
      graceSeconds: 60,
    });
    const observe = new Date(t1.getTime() + 5 * 60 * 1000);
    const meta = await getTenantWebhookSecretMetadata(adapter, 'tenant-A', {
      now: () => observe,
    });
    expect(meta!.previous).toBeUndefined();
  });
});

describe('purgeExpiredPreviousSecrets', () => {
  it('removes expired previous material across all tenants', async () => {
    const adapter = freshAdapter();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-02T00:00:00.000Z');
    // Tenant A rotates with short window -> will expire.
    await rotateTenantWebhookSecret(adapter, 'tenant-A', { now: () => t0 });
    await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => t1,
      graceSeconds: 60,
    });
    // Tenant B rotates with long window -> still active.
    await rotateTenantWebhookSecret(adapter, 'tenant-B', { now: () => t0 });
    await rotateTenantWebhookSecret(adapter, 'tenant-B', {
      now: () => t1,
      graceSeconds: 24 * 60 * 60,
    });
    // Tenant C has only an initial mint -> nothing to purge.
    await rotateTenantWebhookSecret(adapter, 'tenant-C', { now: () => t0 });

    const observe = new Date(t1.getTime() + 5 * 60 * 1000);
    const result = await purgeExpiredPreviousSecrets(adapter, {
      now: () => observe,
    });

    expect(result.tenantIds).toEqual(['tenant-A']);
    const recA = await adapter.fetchData<TenantWebhookSecretRecord>(
      TENANT_WEBHOOK_SECRETS_COLLECTION,
      'tenant-A'
    );
    expect(recA!.previous).toBeUndefined();
    expect(recA!.previousExpiresAt).toBeUndefined();
    const recB = await adapter.fetchData<TenantWebhookSecretRecord>(
      TENANT_WEBHOOK_SECRETS_COLLECTION,
      'tenant-B'
    );
    expect(recB!.previous).toBeDefined();
  });

  it('is idempotent — a second run is a no-op', async () => {
    const adapter = freshAdapter();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-02T00:00:00.000Z');
    await rotateTenantWebhookSecret(adapter, 'tenant-A', { now: () => t0 });
    await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => t1,
      graceSeconds: 60,
    });
    const observe = new Date(t1.getTime() + 5 * 60 * 1000);
    await purgeExpiredPreviousSecrets(adapter, { now: () => observe });
    const second = await purgeExpiredPreviousSecrets(adapter, {
      now: () => observe,
    });
    expect(second.tenantIds).toEqual([]);
  });

  // Cleanup of temp dirs is intentionally left to the OS; tests run in CI ephemeral env.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function _unusedRmHelper(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
