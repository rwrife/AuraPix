import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import { TENANT_PLUGIN_CONFIG_COLLECTION } from '../../models/TenantPluginConfig.js';
import {
  defaultEnabledPluginIds,
  fetchTenantPluginConfig,
  getEffectiveEnabledPluginIds,
  getOrInitTenantPluginConfig,
  setTenantPluginEnabled,
} from './tenantPluginConfigService.js';

/**
 * Build a stub DataAdapter that stores docs in an in-memory map. Tests
 * inspect the map and the underlying mocks to verify behavior.
 */
function makeMemoryAdapter(): {
  data: DataAdapter;
  store: Map<string, Map<string, unknown>>;
} {
  const store = new Map<string, Map<string, unknown>>();
  const get = (collection: string) => {
    let inner = store.get(collection);
    if (!inner) {
      inner = new Map();
      store.set(collection, inner);
    }
    return inner;
  };
  const adapter: DataAdapter = {
    storeData: vi.fn(async (collection: string, id: string, value: unknown) => {
      get(collection).set(id, value);
    }),
    fetchData: vi.fn(async <T>(collection: string, id: string) => {
      const value = get(collection).get(id);
      return (value ?? null) as T | null;
    }),
    queryData: vi.fn(async () => []),
    updateData: vi.fn(async () => {}),
    deleteData: vi.fn(async (collection: string, id: string) => {
      get(collection).delete(id);
    }),
    exists: vi.fn(async (collection: string, id: string) =>
      get(collection).has(id)
    ),
    listIds: vi.fn(async (collection: string) =>
      Array.from(get(collection).keys())
    ),
    getPhoto: vi.fn(async () => null),
  } as unknown as DataAdapter;
  return { data: adapter, store };
}

describe('tenantPluginConfigService', () => {
  describe('default-on policy', () => {
    it('returns every built-in plugin when the tenant has no doc', async () => {
      const { data } = makeMemoryAdapter();
      const ids = await getEffectiveEnabledPluginIds(data, 'tenant-a');
      expect(ids).toEqual(new Set(defaultEnabledPluginIds()));
    });

    it('treats a malformed doc (no enabledPluginIds array) as default-on', async () => {
      // Defends against test fixtures whose fetchData stub returns a Photo
      // for every collection, and against real-world malformed docs.
      const { data, store } = makeMemoryAdapter();
      store.set(
        TENANT_PLUGIN_CONFIG_COLLECTION,
        new Map([['tenant-a', { tenantId: 'tenant-a', shape: 'broken' }]])
      );
      const ids = await getEffectiveEnabledPluginIds(data, 'tenant-a');
      expect(ids).toEqual(new Set(defaultEnabledPluginIds()));
    });
  });

  describe('fetchTenantPluginConfig', () => {
    it('returns null when no doc exists', async () => {
      const { data } = makeMemoryAdapter();
      const doc = await fetchTenantPluginConfig(data, 'tenant-a');
      expect(doc).toBeNull();
    });

    it('returns null for an empty tenantId', async () => {
      const { data } = makeMemoryAdapter();
      const doc = await fetchTenantPluginConfig(data, '');
      expect(doc).toBeNull();
    });
  });

  describe('getOrInitTenantPluginConfig', () => {
    it('lazy-writes a default-on doc on first read', async () => {
      const { data, store } = makeMemoryAdapter();
      const doc = await getOrInitTenantPluginConfig(data, 'tenant-a', {
        actor: 'tak_x',
      });
      expect(doc.tenantId).toBe('tenant-a');
      expect(doc.enabledPluginIds.sort()).toEqual(
        defaultEnabledPluginIds().sort()
      );
      expect(doc.updatedBy).toBe('tak_x');
      // Persisted to storage.
      expect(store.get(TENANT_PLUGIN_CONFIG_COLLECTION)?.get('tenant-a')).toEqual(
        doc
      );
    });

    it('returns the existing doc instead of overwriting', async () => {
      const { data, store } = makeMemoryAdapter();
      store.set(
        TENANT_PLUGIN_CONFIG_COLLECTION,
        new Map([
          [
            'tenant-a',
            {
              tenantId: 'tenant-a',
              enabledPluginIds: ['rotate'],
              updatedAt: '2024-01-01T00:00:00.000Z',
              updatedBy: 'admin',
            },
          ],
        ])
      );
      const doc = await getOrInitTenantPluginConfig(data, 'tenant-a');
      expect(doc.enabledPluginIds).toEqual(['rotate']);
      expect(doc.updatedBy).toBe('admin');
    });

    it('falls back to in-memory default when storage write fails', async () => {
      const { data } = makeMemoryAdapter();
      (data.storeData as any).mockImplementationOnce(async () => {
        throw new Error('boom');
      });
      const doc = await getOrInitTenantPluginConfig(data, 'tenant-a');
      expect(doc.enabledPluginIds.sort()).toEqual(
        defaultEnabledPluginIds().sort()
      );
    });
  });

  describe('setTenantPluginEnabled', () => {
    let memory: ReturnType<typeof makeMemoryAdapter>;
    beforeEach(() => {
      memory = makeMemoryAdapter();
    });

    it('disables a plugin from a default-on tenant and reports a change', async () => {
      const result = await setTenantPluginEnabled(memory.data, {
        tenantId: 'tenant-a',
        pluginId: 'rotate',
        enabled: false,
        actor: 'tak_a',
      });
      expect(result.previous).toBe(true);
      expect(result.changed).toBe(true);
      expect(result.record.enabledPluginIds).not.toContain('rotate');
      expect(result.record.updatedBy).toBe('tak_a');
    });

    it('reports changed=false when the new state matches the existing state', async () => {
      // Existing doc explicitly excludes `rotate`.
      memory.store.set(
        TENANT_PLUGIN_CONFIG_COLLECTION,
        new Map([
          [
            'tenant-a',
            {
              tenantId: 'tenant-a',
              enabledPluginIds: ['crop', 'adjust', 'filter'],
              updatedAt: '2024-01-01T00:00:00.000Z',
              updatedBy: null,
            },
          ],
        ])
      );
      const result = await setTenantPluginEnabled(memory.data, {
        tenantId: 'tenant-a',
        pluginId: 'rotate',
        enabled: false,
      });
      expect(result.previous).toBe(false);
      expect(result.changed).toBe(false);
    });

    it('rejects unknown plugin ids', async () => {
      await expect(
        setTenantPluginEnabled(memory.data, {
          tenantId: 'tenant-a',
          pluginId: 'bogus' as never,
          enabled: true,
        })
      ).rejects.toThrow(/Unknown plugin id/);
    });

    it('rejects empty tenantId', async () => {
      await expect(
        setTenantPluginEnabled(memory.data, {
          tenantId: '',
          pluginId: 'rotate',
          enabled: true,
        })
      ).rejects.toThrow(/tenantId is required/);
    });

    it('round-trips through getEffectiveEnabledPluginIds', async () => {
      await setTenantPluginEnabled(memory.data, {
        tenantId: 'tenant-a',
        pluginId: 'rotate',
        enabled: false,
      });
      const ids = await getEffectiveEnabledPluginIds(memory.data, 'tenant-a');
      expect(ids.has('rotate')).toBe(false);
      expect(ids.has('crop')).toBe(true);
    });
  });
});
