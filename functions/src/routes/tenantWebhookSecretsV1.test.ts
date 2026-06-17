/**
 * Route-level tests for the webhook signing-secret rotation API
 * (issue #161). Uses real Express + node fetch (no new test deps) so the
 * middleware stack (host API key auth, scope guard, JSON body parsing) is
 * exercised end-to-end.
 *
 * Covers:
 *   - Successful rotation returns the plaintext exactly once + metadata
 *   - GET secret returns metadata only, never the plaintext
 *   - Unauthorized rotation (missing auth) is rejected with 401
 *   - Wrong-scope key is rejected with 403
 *   - Cross-tenant request is rejected with 403
 *   - graceSeconds validation errors with 400
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalJsonData } from '../adapters/data/LocalJsonData.js';
import { createTenantWebhookSecretsRouter } from './tenantWebhookSecretsV1.js';
import { createHostApiKeyAuth } from '../middleware/hostApiKeyAuth.js';
import { createTenantApiKey } from '../services/host/tenantApiKeyService.js';

interface Harness {
  baseUrl: string;
  shutdown(): Promise<void>;
  dataAdapter: LocalJsonData;
  emittedEvents: Array<{ type: string; tenantId: string; meta?: unknown }>;
}

async function setupHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-secret-route-test-'));
  const dataAdapter = new LocalJsonData(dir);
  const emittedEvents: Harness['emittedEvents'] = [];
  const app = express();
  app.use(express.json());
  app.use(createHostApiKeyAuth(dataAdapter));
  // NOTE: optionalAuthMiddleware is intentionally omitted from this test
  // harness because in local/mock mode it auto-assigns a user and would
  // bypass the unauthorized-rejection scenarios we need to exercise. The
  // production server wires both middlewares; the scope guard still
  // enforces tenant ownership for host API keys regardless.
  app.use(
    '/api/v1/tenants',
    createTenantWebhookSecretsRouter({
      dataAdapter,
      meteringBus: {
        emit: (event) => {
          emittedEvents.push({
            type: event.type,
            tenantId: event.tenantId,
            meta: event.meta,
          });
        },
      },
    })
  );

  // Bind to an ephemeral port.
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataAdapter,
    emittedEvents,
    shutdown: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

describe('tenantWebhookSecretsV1 router', () => {
  let harness: Harness;
  let validKeySecret: string;
  let wrongScopeKeySecret: string;
  let otherTenantKeySecret: string;

  beforeEach(async () => {
    harness = await setupHarness();
    const valid = await createTenantApiKey(harness.dataAdapter, {
      tenantId: 'tenant-A',
      scopes: ['webhooks.write'],
      label: 'rotation-test',
    });
    validKeySecret = valid.plaintextSecret;

    const wrong = await createTenantApiKey(harness.dataAdapter, {
      tenantId: 'tenant-A',
      scopes: ['usage.read'],
      label: 'no-webhook-scope',
    });
    wrongScopeKeySecret = wrong.plaintextSecret;

    const other = await createTenantApiKey(harness.dataAdapter, {
      tenantId: 'tenant-B',
      scopes: ['webhooks.write'],
      label: 'cross-tenant',
    });
    otherTenantKeySecret = other.plaintextSecret;
  });

  afterEach(async () => {
    await harness.shutdown();
  });

  it('POST rotate-secret returns the plaintext secret exactly once + metadata', async () => {
    const res = await fetch(
      `${harness.baseUrl}/api/v1/tenants/tenant-A/webhooks/rotate-secret`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${validKeySecret}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tenantId).toBe('tenant-A');
    expect(typeof body.secret).toBe('string');
    expect((body.secret as string).startsWith('whsec_')).toBe(true);
    expect(body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof body.rotatedAt).toBe('string');
    expect(typeof body.rotatesAt).toBe('string');
    expect(body.previous).toBeNull();

    // GET must not return the plaintext.
    const meta = await fetch(
      `${harness.baseUrl}/api/v1/tenants/tenant-A/webhooks/secret`,
      { headers: { authorization: `Bearer ${validKeySecret}` } }
    );
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as Record<string, unknown>;
    expect(JSON.stringify(metaBody)).not.toContain('whsec_');
    expect(metaBody.fingerprint).toBe(body.fingerprint);

    // Metering event fired exactly once.
    expect(harness.emittedEvents).toHaveLength(1);
    expect(harness.emittedEvents[0]!.type).toBe('webhook.secret_rotated');
    expect(harness.emittedEvents[0]!.tenantId).toBe('tenant-A');
  });

  it('second rotation produces a previous block with expiresAt', async () => {
    await fetch(
      `${harness.baseUrl}/api/v1/tenants/tenant-A/webhooks/rotate-secret`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${validKeySecret}`,
        },
        body: JSON.stringify({}),
      }
    );
    const res = await fetch(
      `${harness.baseUrl}/api/v1/tenants/tenant-A/webhooks/rotate-secret`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${validKeySecret}`,
        },
        body: JSON.stringify({ graceSeconds: 60 * 60 }), // 1h
      }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.previous).not.toBeNull();
    const prev = body.previous as Record<string, unknown>;
    expect(prev.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof prev.expiresAt).toBe('string');
    expect(typeof prev.createdAt).toBe('string');
  });

  it('rejects rotation with no authentication (401)', async () => {
    const res = await fetch(
      `${harness.baseUrl}/api/v1/tenants/tenant-A/webhooks/rotate-secret`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }
    );
    expect(res.status).toBe(401);
  });

  it('rejects rotation with a key missing webhooks.write scope (403)', async () => {
    const res = await fetch(
      `${harness.baseUrl}/api/v1/tenants/tenant-A/webhooks/rotate-secret`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${wrongScopeKeySecret}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; missing?: string[] };
    expect(body.error).toMatch(/scope/i);
    expect(body.missing).toContain('webhooks.write');
  });

  it('rejects cross-tenant rotation (403)', async () => {
    const res = await fetch(
      `${harness.baseUrl}/api/v1/tenants/tenant-A/webhooks/rotate-secret`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Key is scoped to tenant-B; target path is tenant-A.
          authorization: `Bearer ${otherTenantKeySecret}`,
        },
        body: JSON.stringify({}),
      }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/cross-tenant/i);
    expect(harness.emittedEvents).toHaveLength(0);
  });

  it('rejects rotation with invalid graceSeconds (400)', async () => {
    const res = await fetch(
      `${harness.baseUrl}/api/v1/tenants/tenant-A/webhooks/rotate-secret`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${validKeySecret}`,
        },
        body: JSON.stringify({ graceSeconds: -5 }),
      }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('GET secret returns 404 when no secret has been minted', async () => {
    const res = await fetch(
      `${harness.baseUrl}/api/v1/tenants/tenant-A/webhooks/secret`,
      { headers: { authorization: `Bearer ${validKeySecret}` } }
    );
    expect(res.status).toBe(404);
  });
});
