import { describe, it, expect, beforeEach } from 'vitest';
import {
  mintEmbedSessionToken,
  verifyAndRedeemEmbedSessionToken,
  hashJtiForMetering,
  _internalBuildTokenForTests,
  EMBED_SESSION_TOKEN_AUDIENCE,
  EMBED_SESSION_TOKEN_DEFAULT_TTL_SECONDS,
  EMBED_SESSION_TOKEN_MAX_TTL_SECONDS,
  EMBED_SESSION_TOKEN_JTI_COLLECTION,
  type EmbedSessionTokenClaims,
  type EmbedSessionTokenJtiRecord,
} from '../../../src/services/host/embedSessionTokenService.js';
import type { DataAdapter } from '../../../src/adapters/data/DataAdapter.js';
import {
  TENANT_MEMBERS_COLLECTION,
  tenantMemberDocId,
  type TenantMemberRecord,
} from '../../../src/models/TenantMember.js';

interface TestAdapter extends DataAdapter {
  _store: Record<string, Record<string, unknown>>;
}

function makeAdapter(): TestAdapter {
  const store: Record<string, Record<string, unknown>> = {};
  const get = (c: string): Record<string, unknown> => {
    if (!store[c]) store[c] = {};
    return store[c];
  };
  return {
    _store: store,
    async storeData(collection, id, data) {
      get(collection)[id] = data as never;
    },
    async fetchData(collection, id) {
      return (get(collection)[id] as never) ?? null;
    },
    async queryData() {
      return [];
    },
    async updateData() {},
    async deleteData(collection, id) {
      delete get(collection)[id];
    },
    async exists(collection, id) {
      return id in get(collection);
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
  secret = 'whsec_test_current'
): void {
  adapter._store['tenantWebhookSecrets'] ??= {};
  adapter._store['tenantWebhookSecrets'][tenantId] = {
    tenantId,
    current: {
      secret,
      fingerprint: 'fp_current',
      createdAt: new Date('2026-01-01').toISOString(),
    },
    rotatedAt: new Date('2026-01-01').toISOString(),
    updatedAt: new Date('2026-01-01').toISOString(),
  } as never;
}

function seedRotatedSecret(
  adapter: TestAdapter,
  tenantId: string,
  currentSecret: string,
  previousSecret: string,
  graceMs: number
): void {
  adapter._store['tenantWebhookSecrets'] ??= {};
  adapter._store['tenantWebhookSecrets'][tenantId] = {
    tenantId,
    current: {
      secret: currentSecret,
      fingerprint: 'fp_new',
      createdAt: new Date().toISOString(),
    },
    previous: {
      secret: previousSecret,
      fingerprint: 'fp_old',
      createdAt: new Date(Date.now() - graceMs).toISOString(),
    },
    previousExpiresAt: new Date(Date.now() + graceMs).toISOString(),
    rotatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;
}

describe('embedSessionTokenService — constants', () => {
  it('matches the documented audience and TTL caps', () => {
    expect(EMBED_SESSION_TOKEN_AUDIENCE).toBe('aurapix:embed');
    expect(EMBED_SESSION_TOKEN_MAX_TTL_SECONDS).toBe(300);
    expect(EMBED_SESSION_TOKEN_DEFAULT_TTL_SECONDS).toBe(120);
  });
});

describe('mintEmbedSessionToken', () => {
  let adapter: TestAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('mints a 3-segment JWT with required claims', async () => {
    seedMembership(adapter, 'acme', 'u_1', 'editor');
    seedSigningSecret(adapter, 'acme');

    const result = await mintEmbedSessionToken(adapter, {
      tenantId: 'acme',
      userId: 'u_1',
    });
    if ('code' in result) throw new Error(`expected success: ${result.code}`);

    expect(result.role).toBe('editor');
    expect(result.token.split('.')).toHaveLength(3);
    expect(typeof result.jti).toBe('string');
    expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Decode payload and confirm shape.
    const [, payload] = result.token.split('.');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(
      Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf8'
      )
    );
    expect(claims.iss).toBe('acme');
    expect(claims.aud).toBe('aurapix:embed');
    expect(claims.sub).toBe('u_1');
    expect(claims.role).toBe('editor');
    expect(typeof claims.jti).toBe('string');
    expect(claims.exp - claims.iat).toBe(EMBED_SESSION_TOKEN_DEFAULT_TTL_SECONDS);
  });

  it('rejects when the user is not a tenant member', async () => {
    // No membership seeded.
    seedSigningSecret(adapter, 'acme');
    const result = await mintEmbedSessionToken(adapter, {
      tenantId: 'acme',
      userId: 'u_ghost',
    });
    expect('code' in result && result.code).toBe('user_not_member');
  });

  it('rejects when the tenant has no signing secret', async () => {
    seedMembership(adapter, 'acme', 'u_1', 'editor');
    const result = await mintEmbedSessionToken(adapter, {
      tenantId: 'acme',
      userId: 'u_1',
    });
    expect('code' in result && result.code).toBe('no_signing_secret');
  });

  it('rejects invalid role values', async () => {
    seedMembership(adapter, 'acme', 'u_1', 'editor');
    seedSigningSecret(adapter, 'acme');
    const result = await mintEmbedSessionToken(adapter, {
      tenantId: 'acme',
      userId: 'u_1',
      role: 'super-admin' as never,
    });
    expect('code' in result && result.code).toBe('invalid_input');
  });

  it('clamps ttlSeconds to the 300s cap', async () => {
    seedMembership(adapter, 'acme', 'u_1');
    seedSigningSecret(adapter, 'acme');
    const result = await mintEmbedSessionToken(adapter, {
      tenantId: 'acme',
      userId: 'u_1',
      ttlSeconds: 99_999,
    });
    if ('code' in result) throw new Error('expected success');
    const payload = result.token.split('.')[1];
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(
      Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf8'
      )
    );
    expect(claims.exp - claims.iat).toBe(EMBED_SESSION_TOKEN_MAX_TTL_SECONDS);
  });

  it('honors an explicit role override', async () => {
    seedMembership(adapter, 'acme', 'u_1', 'viewer');
    seedSigningSecret(adapter, 'acme');
    const result = await mintEmbedSessionToken(adapter, {
      tenantId: 'acme',
      userId: 'u_1',
      role: 'editor',
    });
    if ('code' in result) throw new Error('expected success');
    expect(result.role).toBe('editor');
  });
});

describe('verifyAndRedeemEmbedSessionToken', () => {
  let adapter: TestAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
    seedMembership(adapter, 'acme', 'u_1', 'editor');
    seedSigningSecret(adapter, 'acme');
  });

  it('accepts a freshly minted token', async () => {
    const minted = await mintEmbedSessionToken(adapter, {
      tenantId: 'acme',
      userId: 'u_1',
    });
    if ('code' in minted) throw new Error('mint failed');

    const verified = await verifyAndRedeemEmbedSessionToken(adapter, minted.token, {
      expectedTenantId: 'acme',
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sub).toBe('u_1');
      expect(verified.claims.role).toBe('editor');
      expect(verified.matchedSecret).toBe('current');
    }
  });

  it('rejects a second redemption of the same token (replay)', async () => {
    const minted = await mintEmbedSessionToken(adapter, {
      tenantId: 'acme',
      userId: 'u_1',
    });
    if ('code' in minted) throw new Error('mint failed');

    const first = await verifyAndRedeemEmbedSessionToken(adapter, minted.token, {
      expectedTenantId: 'acme',
    });
    expect(first.ok).toBe(true);
    const second = await verifyAndRedeemEmbedSessionToken(adapter, minted.token, {
      expectedTenantId: 'acme',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('token_replayed');
  });

  it('rejects cross-tenant tokens (iss != expectedTenantId)', async () => {
    const minted = await mintEmbedSessionToken(adapter, {
      tenantId: 'acme',
      userId: 'u_1',
    });
    if ('code' in minted) throw new Error('mint failed');

    seedMembership(adapter, 'other', 'u_1', 'editor');
    seedSigningSecret(adapter, 'other', 'other_secret');

    const verified = await verifyAndRedeemEmbedSessionToken(adapter, minted.token, {
      expectedTenantId: 'other',
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe('tenant_mismatch');
  });

  it('rejects an expired token', async () => {
    const past = new Date('2024-01-01T00:00:00Z');
    const minted = await mintEmbedSessionToken(
      adapter,
      { tenantId: 'acme', userId: 'u_1', ttlSeconds: 30 },
      { now: () => past }
    );
    if ('code' in minted) throw new Error('mint failed');

    const verified = await verifyAndRedeemEmbedSessionToken(adapter, minted.token, {
      expectedTenantId: 'acme',
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe('token_expired');
  });

  it('rejects a tampered signature', async () => {
    const minted = await mintEmbedSessionToken(adapter, {
      tenantId: 'acme',
      userId: 'u_1',
    });
    if ('code' in minted) throw new Error('mint failed');
    const [h, p] = minted.token.split('.');
    const tampered = `${h}.${p}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const verified = await verifyAndRedeemEmbedSessionToken(adapter, tampered, {
      expectedTenantId: 'acme',
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe('invalid_token');
  });

  it('rejects a token signed with the wrong secret', async () => {
    // Hand-craft a token using a different secret.
    const claims: EmbedSessionTokenClaims = {
      iss: 'acme',
      aud: EMBED_SESSION_TOKEN_AUDIENCE,
      sub: 'u_1',
      role: 'editor',
      jti: 'jti-1',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const bogus = _internalBuildTokenForTests(claims, 'whsec_not_the_one');
    const verified = await verifyAndRedeemEmbedSessionToken(adapter, bogus, {
      expectedTenantId: 'acme',
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe('invalid_token');
  });

  it('accepts a token signed with the previous secret during the grace window', async () => {
    seedRotatedSecret(adapter, 'acme', 'whsec_new', 'whsec_old', 60_000);

    const claims: EmbedSessionTokenClaims = {
      iss: 'acme',
      aud: EMBED_SESSION_TOKEN_AUDIENCE,
      sub: 'u_1',
      role: 'editor',
      jti: 'jti-rot',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const token = _internalBuildTokenForTests(claims, 'whsec_old');
    const verified = await verifyAndRedeemEmbedSessionToken(adapter, token, {
      expectedTenantId: 'acme',
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.matchedSecret).toBe('previous');
  });

  it('rejects when the user has since lost membership', async () => {
    const minted = await mintEmbedSessionToken(adapter, {
      tenantId: 'acme',
      userId: 'u_1',
    });
    if ('code' in minted) throw new Error('mint failed');
    // Wipe the membership before exchange.
    delete (adapter._store[TENANT_MEMBERS_COLLECTION] ??= {})[
      tenantMemberDocId('acme', 'u_1')
    ];
    const verified = await verifyAndRedeemEmbedSessionToken(adapter, minted.token, {
      expectedTenantId: 'acme',
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe('user_not_member');
  });

  it('rejects garbage strings without crashing', async () => {
    for (const garbage of ['', 'abc', 'a.b', 'a.b.c.d', '.'.repeat(10_000)]) {
      const verified = await verifyAndRedeemEmbedSessionToken(adapter, garbage, {
        expectedTenantId: 'acme',
      });
      expect(verified.ok).toBe(false);
    }
  });

  it('persists a jti record on redemption', async () => {
    const minted = await mintEmbedSessionToken(adapter, {
      tenantId: 'acme',
      userId: 'u_1',
    });
    if ('code' in minted) throw new Error('mint failed');
    await verifyAndRedeemEmbedSessionToken(adapter, minted.token, {
      expectedTenantId: 'acme',
    });
    const jtiBucket = adapter._store[EMBED_SESSION_TOKEN_JTI_COLLECTION] ?? {};
    const records = Object.values(jtiBucket) as EmbedSessionTokenJtiRecord[];
    expect(records).toHaveLength(1);
    expect(records[0].tenantId).toBe('acme');
    expect(records[0].userId).toBe('u_1');
  });
});

describe('hashJtiForMetering', () => {
  it('returns 16 hex characters and is stable', () => {
    const a = hashJtiForMetering('jti-a');
    const b = hashJtiForMetering('jti-a');
    const c = hashJtiForMetering('jti-b');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
