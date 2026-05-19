import { beforeEach, describe, expect, it } from 'vitest';
import type {
  DataAdapter,
  QueryFilter,
} from '../../adapters/data/DataAdapter.js';
import {
  TENANT_API_KEYS_COLLECTION,
  TENANT_API_KEY_PREFIX,
  type TenantApiKeyRecord,
} from '../../models/TenantApiKey.js';
import {
  authenticatePlaintextKey,
  constantTimeHashCompare,
  createTenantApiKey,
  extractKeyPrefix,
  hashSecret,
  listTenantApiKeys,
  redactTenantApiKey,
  revokeTenantApiKey,
  validateScopes,
} from './tenantApiKeyService.js';

function createInMemoryAdapter(): DataAdapter & {
  store: Map<string, Map<string, any>>;
} {
  const store = new Map<string, Map<string, any>>();
  function col(name: string): Map<string, any> {
    let c = store.get(name);
    if (!c) {
      c = new Map();
      store.set(name, c);
    }
    return c;
  }
  const adapter: DataAdapter & { store: Map<string, Map<string, any>> } = {
    store,
    async storeData(collection, id, data) {
      col(collection).set(id, { ...(data as object) });
    },
    async fetchData<T>(collection: string, id: string): Promise<T | null> {
      const v = col(collection).get(id);
      return (v as T) ?? null;
    },
    async queryData<T>(collection: string, filters: QueryFilter[]): Promise<T[]> {
      const all = Array.from(col(collection).values());
      const matched = all.filter((doc) =>
        filters.every((f) => {
          switch (f.operator) {
            case '==':
              return (doc as any)[f.field] === f.value;
            case '!=':
              return (doc as any)[f.field] !== f.value;
            default:
              return false;
          }
        })
      );
      return matched as T[];
    },
    async updateData(collection, id, updates) {
      const c = col(collection);
      const existing = c.get(id);
      if (existing) c.set(id, { ...existing, ...(updates as object) });
    },
    async deleteData(collection, id) {
      col(collection).delete(id);
    },
    async exists(collection, id) {
      return col(collection).has(id);
    },
    async listIds(collection) {
      return Array.from(col(collection).keys());
    },
    async getPhoto() {
      return null;
    },
  };
  return adapter;
}

describe('tenantApiKeyService', () => {
  let adapter: ReturnType<typeof createInMemoryAdapter>;
  beforeEach(() => {
    adapter = createInMemoryAdapter();
  });

  describe('validateScopes', () => {
    it('accepts known scopes', () => {
      expect(validateScopes(['usage.read'])).toEqual(['usage.read']);
      expect(validateScopes(['usage.read', 'tenants.read'])).toEqual([
        'usage.read',
        'tenants.read',
      ]);
    });
    it('dedupes scopes', () => {
      expect(validateScopes(['usage.read', 'usage.read'])).toEqual(['usage.read']);
    });
    it('rejects empty or unknown scopes', () => {
      expect(() => validateScopes([])).toThrow();
      expect(() => validateScopes(['admin.users'])).toThrow();
      expect(() => validateScopes('usage.read' as any)).toThrow();
    });
  });

  describe('hashSecret + constantTimeHashCompare', () => {
    it('produces stable SHA-256 hex digests', () => {
      const h = hashSecret('hello');
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(hashSecret('hello')).toBe(h);
      expect(hashSecret('hello!')).not.toBe(h);
    });
    it('compares equal-length strings safely', () => {
      const a = hashSecret('a');
      expect(constantTimeHashCompare(a, a)).toBe(true);
      expect(constantTimeHashCompare(a, hashSecret('b'))).toBe(false);
      expect(constantTimeHashCompare(a, a.slice(0, -1))).toBe(false);
    });
  });

  describe('extractKeyPrefix', () => {
    it('returns the first 12 chars for valid keys', () => {
      expect(extractKeyPrefix('ak_live_ABCDEFGH')).toBe('ak_live_ABCD');
    });
    it('rejects non-key inputs', () => {
      expect(extractKeyPrefix('bearer-xyz')).toBeNull();
      expect(extractKeyPrefix('ak_live_')).toBeNull();
      expect(extractKeyPrefix('')).toBeNull();
    });
  });

  describe('createTenantApiKey', () => {
    it('returns plaintext exactly once and stores only the hash', async () => {
      const created = await createTenantApiKey(adapter, {
        tenantId: 'tenant-a',
        scopes: ['usage.read'],
        label: 'rollup',
      });
      expect(created.plaintextSecret.startsWith(TENANT_API_KEY_PREFIX)).toBe(true);
      expect(created.record.hashedSecret).toBe(hashSecret(created.plaintextSecret));
      // Stored document must contain only the hash, never the plaintext.
      const stored = adapter.store
        .get(TENANT_API_KEYS_COLLECTION)!
        .get(created.record.id);
      expect(stored.hashedSecret).toBe(created.record.hashedSecret);
      expect(JSON.stringify(stored)).not.toContain(created.plaintextSecret);
      expect(stored.keyPrefix).toBe(created.plaintextSecret.slice(0, 12));
      expect(stored.scopes).toEqual(['usage.read']);
      expect(stored.lastUsedAt).toBeNull();
      expect(stored.revokedAt).toBeNull();
      expect(stored.label).toBe('rollup');
    });

    it('rejects missing tenantId', async () => {
      await expect(
        createTenantApiKey(adapter, { tenantId: '', scopes: ['usage.read'] })
      ).rejects.toThrow();
    });
  });

  describe('authenticatePlaintextKey', () => {
    it('authenticates a valid key and returns the record', async () => {
      const created = await createTenantApiKey(adapter, {
        tenantId: 'tenant-a',
        scopes: ['usage.read'],
      });
      const result = await authenticatePlaintextKey(adapter, created.plaintextSecret);
      expect(result).not.toBeNull();
      expect(result!.record.id).toBe(created.record.id);
      expect(result!.record.tenantId).toBe('tenant-a');
    });

    it('rejects an unknown key', async () => {
      const result = await authenticatePlaintextKey(
        adapter,
        'ak_live_definitely_not_real_key_value_here_xx'
      );
      expect(result).toBeNull();
    });

    it('rejects a non-key shaped token', async () => {
      expect(await authenticatePlaintextKey(adapter, 'not-a-key')).toBeNull();
    });

    it('rejects a revoked key', async () => {
      const created = await createTenantApiKey(adapter, {
        tenantId: 'tenant-a',
        scopes: ['usage.read'],
      });
      await revokeTenantApiKey(adapter, 'tenant-a', created.record.id);
      const result = await authenticatePlaintextKey(adapter, created.plaintextSecret);
      expect(result).toBeNull();
    });

    it('rejects when prefix matches but full hash does not', async () => {
      // Manually plant a row with a chosen prefix but mismatched hash.
      const fakePlaintext = 'ak_live_collide_aaaa_bbbb_cccc_dddd_eeee';
      const prefix = fakePlaintext.slice(0, 12);
      const record: TenantApiKeyRecord = {
        id: 'tak_fake',
        tenantId: 'tenant-a',
        keyPrefix: prefix,
        hashedSecret: hashSecret('something-else'),
        scopes: ['usage.read'],
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      };
      await adapter.storeData(TENANT_API_KEYS_COLLECTION, record.id, record);
      const result = await authenticatePlaintextKey(adapter, fakePlaintext);
      expect(result).toBeNull();
    });
  });

  describe('listTenantApiKeys + revokeTenantApiKey', () => {
    it('lists only keys for the tenant', async () => {
      const a1 = await createTenantApiKey(adapter, {
        tenantId: 'tenant-a',
        scopes: ['usage.read'],
      });
      await createTenantApiKey(adapter, {
        tenantId: 'tenant-b',
        scopes: ['usage.read'],
      });
      const listed = await listTenantApiKeys(adapter, 'tenant-a');
      expect(listed.map((k) => k.id)).toEqual([a1.record.id]);
    });

    it('refuses cross-tenant revocation', async () => {
      const created = await createTenantApiKey(adapter, {
        tenantId: 'tenant-a',
        scopes: ['usage.read'],
      });
      const result = await revokeTenantApiKey(
        adapter,
        'tenant-b',
        created.record.id
      );
      expect(result).toBeNull();
      // Key remains usable.
      const auth = await authenticatePlaintextKey(adapter, created.plaintextSecret);
      expect(auth).not.toBeNull();
    });

    it('revocation is idempotent', async () => {
      const created = await createTenantApiKey(adapter, {
        tenantId: 'tenant-a',
        scopes: ['usage.read'],
      });
      const first = await revokeTenantApiKey(adapter, 'tenant-a', created.record.id);
      const second = await revokeTenantApiKey(adapter, 'tenant-a', created.record.id);
      expect(first?.revokedAt).toBeTruthy();
      expect(second?.revokedAt).toBe(first?.revokedAt);
    });
  });

  describe('redactTenantApiKey', () => {
    it('omits hashedSecret', async () => {
      const created = await createTenantApiKey(adapter, {
        tenantId: 'tenant-a',
        scopes: ['usage.read'],
      });
      const redacted = redactTenantApiKey(created.record);
      expect((redacted as any).hashedSecret).toBeUndefined();
      expect(redacted.id).toBe(created.record.id);
    });
  });
});
