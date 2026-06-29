/**
 * Tests for the host-issued embed session token routes (issue #195):
 * - POST /v1/tenants/:tenantId/embed/session-tokens (mint)
 * - POST /v1/tenants/:tenantId/embed/session-exchange (redeem)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createEmbedV1Router } from '../../src/routes/embedV1.js';
import type { DataAdapter } from '../../src/adapters/data/DataAdapter.js';
import {
  TENANT_MEMBERS_COLLECTION,
  tenantMemberDocId,
  type TenantMemberRecord,
} from '../../src/models/TenantMember.js';

interface TestAdapter extends DataAdapter {
  _store: Record<string, Record<string, unknown>>;
}

function makeAdapter(): TestAdapter {
  const store: Record<string, Record<string, unknown>> = {};
  const bucket = (c: string): Record<string, unknown> => {
    if (!store[c]) store[c] = {};
    return store[c];
  };
  return {
    _store: store,
    async storeData(collection, id, data) {
      bucket(collection)[id] = data as never;
    },
    async fetchData(collection, id) {
      return (bucket(collection)[id] as never) ?? null;
    },
    async queryData() {
      return [];
    },
    async updateData() {},
    async deleteData(collection, id) {
      delete bucket(collection)[id];
    },
    async exists(collection, id) {
      return id in bucket(collection);
    },
    async listIds() {
      return [];
    },
    async getPhoto() {
      return null;
    },
  } as unknown as TestAdapter;
}

function seedMembership(
  adapter: TestAdapter,
  tenantId: string,
  userId: string,
  role: TenantMemberRecord['role'] = 'editor'
): void {
  const record: TenantMemberRecord = {
    userId,
    tenantId,
    email: `${userId}@example.com`,
    role,
    createdAt: new Date('2026-01-01').toISOString(),
    lastActiveAt: null,
    revokedAt: null,
  };
  adapter._store[TENANT_MEMBERS_COLLECTION] ??= {};
  adapter._store[TENANT_MEMBERS_COLLECTION][tenantMemberDocId(tenantId, userId)] =
    record as never;
}

function seedSigningSecret(
  adapter: TestAdapter,
  tenantId: string,
  secret = 'whsec_route_test'
): void {
  adapter._store['tenantWebhookSecrets'] ??= {};
  adapter._store['tenantWebhookSecrets'][tenantId] = {
    tenantId,
    current: {
      secret,
      fingerprint: 'fp',
      createdAt: new Date().toISOString(),
    },
    rotatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;
}

async function request(
  app: express.Express,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const init: RequestInit = {
        method,
        headers: { 'content-type': 'application/json' },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      fetch(`http://127.0.0.1:${port}${path}`, init)
        .then(async (res) => {
          const text = await res.text();
          let parsed: any = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          server.close();
          resolve({ status: res.status, body: parsed });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

function makeApp(
  adapter: DataAdapter,
  opts: Parameters<typeof createEmbedV1Router>[1] = {},
  emit?: (e: unknown) => void
): express.Express {
  const app = express();
  app.use(express.json());
  if (emit) {
    app.use((req, _res, next) => {
      (req.app.locals as any).meteringBus = { emit };
      next();
    });
  }
  app.use('/v1/tenants', createEmbedV1Router(adapter, opts));
  return app;
}

describe('POST /v1/tenants/:tenantId/embed/session-tokens', () => {
  let adapter: TestAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('mints a token for a valid membership and emits embed.session.minted', async () => {
    seedMembership(adapter, 'acme', 'u_42', 'editor');
    seedSigningSecret(adapter, 'acme');
    const emit = vi.fn();
    const app = makeApp(adapter, { canWriteEmbedConfig: () => true }, emit);

    const res = await request(app, 'POST', '/v1/tenants/acme/embed/session-tokens', {
      userId: 'u_42',
      ttlSeconds: 60,
    });

    expect(res.status).toBe(201);
    expect(res.body.audience).toBe('aurapix:embed');
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.split('.')).toHaveLength(3);
    expect(typeof res.body.expiresAt).toBe('string');

    const minted = emit.mock.calls.find(
      ([e]) => (e as any).type === 'embed.session.minted'
    );
    expect(minted).toBeDefined();
    expect((minted![0] as any).tenantId).toBe('acme');
    expect((minted![0] as any).meta.userId).toBe('u_42');
    expect((minted![0] as any).meta.role).toBe('editor');
    expect(typeof (minted![0] as any).meta.jtiHash).toBe('string');
  });

  it('rejects with 409 user_not_member when the user is not provisioned', async () => {
    seedSigningSecret(adapter, 'acme');
    const app = makeApp(adapter, { canWriteEmbedConfig: () => true });
    const res = await request(app, 'POST', '/v1/tenants/acme/embed/session-tokens', {
      userId: 'u_ghost',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('user_not_member');
  });

  it('rejects with 403 when the auth gate denies', async () => {
    seedMembership(adapter, 'acme', 'u_42');
    seedSigningSecret(adapter, 'acme');
    const app = makeApp(adapter, { canWriteEmbedConfig: () => false });
    const res = await request(app, 'POST', '/v1/tenants/acme/embed/session-tokens', {
      userId: 'u_42',
    });
    expect(res.status).toBe(403);
  });

  it('rejects with 400 on an invalid tenantId', async () => {
    const app = makeApp(adapter, { canWriteEmbedConfig: () => true });
    const res = await request(
      app,
      'POST',
      '/v1/tenants/has spaces/embed/session-tokens',
      { userId: 'u_42' }
    );
    expect(res.status).toBe(400);
  });

  it('rejects with 400 on missing userId', async () => {
    seedMembership(adapter, 'acme', 'u_42');
    seedSigningSecret(adapter, 'acme');
    const app = makeApp(adapter, { canWriteEmbedConfig: () => true });
    const res = await request(app, 'POST', '/v1/tenants/acme/embed/session-tokens', {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('rejects with 400 on invalid role', async () => {
    seedMembership(adapter, 'acme', 'u_42');
    seedSigningSecret(adapter, 'acme');
    const app = makeApp(adapter, { canWriteEmbedConfig: () => true });
    const res = await request(app, 'POST', '/v1/tenants/acme/embed/session-tokens', {
      userId: 'u_42',
      role: 'super-admin',
    });
    expect(res.status).toBe(400);
  });

  it('rejects with 400 on ttlSeconds above the cap', async () => {
    seedMembership(adapter, 'acme', 'u_42');
    seedSigningSecret(adapter, 'acme');
    const app = makeApp(adapter, { canWriteEmbedConfig: () => true });
    const res = await request(app, 'POST', '/v1/tenants/acme/embed/session-tokens', {
      userId: 'u_42',
      ttlSeconds: 999,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/tenants/:tenantId/embed/session-exchange', () => {
  let adapter: TestAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  async function mint(tenantId = 'acme', userId = 'u_42'): Promise<string> {
    seedMembership(adapter, tenantId, userId, 'editor');
    seedSigningSecret(adapter, tenantId);
    const app = makeApp(adapter, { canWriteEmbedConfig: () => true });
    const r = await request(app, 'POST', `/v1/tenants/${tenantId}/embed/session-tokens`, {
      userId,
    });
    expect(r.status).toBe(201);
    return r.body.token;
  }

  it('exchanges a valid token and emits embed.session.exchanged', async () => {
    const token = await mint();
    const emit = vi.fn();
    const app = makeApp(adapter, {}, emit);

    const res = await request(app, 'POST', '/v1/tenants/acme/embed/session-exchange', {
      token,
    });
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe('acme');
    expect(res.body.userId).toBe('u_42');
    expect(res.body.role).toBe('editor');

    const exchanged = emit.mock.calls.find(
      ([e]) => (e as any).type === 'embed.session.exchanged'
    );
    expect(exchanged).toBeDefined();
    expect((exchanged![0] as any).meta.userId).toBe('u_42');
  });

  it('rejects a replayed token with 401 token_replayed', async () => {
    const token = await mint();
    const app = makeApp(adapter);
    const first = await request(app, 'POST', '/v1/tenants/acme/embed/session-exchange', {
      token,
    });
    expect(first.status).toBe(200);
    const second = await request(app, 'POST', '/v1/tenants/acme/embed/session-exchange', {
      token,
    });
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe('token_replayed');
  });

  it('rejects a cross-tenant token with 403 tenant_mismatch', async () => {
    const token = await mint('acme', 'u_42');
    // Set up another tenant context with a different signing secret.
    seedMembership(adapter, 'other', 'u_42', 'editor');
    seedSigningSecret(adapter, 'other', 'whsec_other');
    const app = makeApp(adapter);
    const res = await request(app, 'POST', '/v1/tenants/other/embed/session-exchange', {
      token,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('tenant_mismatch');
  });

  it('rejects a garbage token with 401 invalid_token', async () => {
    seedSigningSecret(adapter, 'acme');
    const app = makeApp(adapter);
    const res = await request(app, 'POST', '/v1/tenants/acme/embed/session-exchange', {
      token: 'not.a.realtoken',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_token');
  });

  it('rejects a missing body with 400', async () => {
    const app = makeApp(adapter);
    const res = await request(app, 'POST', '/v1/tenants/acme/embed/session-exchange', {});
    expect(res.status).toBe(400);
  });

  it('invokes issueEmbedSession and echoes its payload', async () => {
    const token = await mint();
    const issueEmbedSession = vi.fn(async (input: any) => ({
      firebaseCustomToken: `ct_${input.userId}`,
    }));
    const app = makeApp(adapter, { issueEmbedSession });
    const res = await request(app, 'POST', '/v1/tenants/acme/embed/session-exchange', {
      token,
    });
    expect(res.status).toBe(200);
    expect(issueEmbedSession).toHaveBeenCalledWith({
      tenantId: 'acme',
      userId: 'u_42',
      role: 'editor',
    });
    expect(res.body.session).toEqual({ firebaseCustomToken: 'ct_u_42' });
  });
});
