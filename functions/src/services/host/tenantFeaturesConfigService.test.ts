import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAG_NAMES,
  TENANT_FEATURES_CONFIG_COLLECTION,
  type TenantFeaturesConfigRecord,
} from '../../models/TenantFeaturesConfig.js';
import {
  __resetTenantFeaturesCacheForTests,
  fetchTenantFeaturesConfig,
  getEffectiveFeatureFlags,
  invalidateTenantFeaturesCache,
  isFeatureEnabled,
  mergeWithDefaults,
  patchTenantFeatures,
} from './tenantFeaturesConfigService.js';

/**
 * Minimal DataAdapter stub backed by an in-memory map. Matches the
 * pattern used elsewhere in the suite (see tenantPluginConfigService.test.ts).
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

describe('tenantFeaturesConfigService', () => {
  beforeEach(() => {
    __resetTenantFeaturesCacheForTests();
  });

  describe('default-on policy (issue #175)', () => {
    it('returns all flags true when the tenant has no doc', async () => {
      const { data } = makeMemoryAdapter();
      const flags = await getEffectiveFeatureFlags(data, 'tenant-a');
      expect(flags).toEqual(DEFAULT_FEATURE_FLAGS);
      // Every named feature must be present and true.
      for (const name of FEATURE_FLAG_NAMES) {
        expect(flags[name]).toBe(true);
      }
    });

    it('isFeatureEnabled returns true for every feature on a fresh tenant', async () => {
      const { data } = makeMemoryAdapter();
      for (const name of FEATURE_FLAG_NAMES) {
        await expect(isFeatureEnabled(data, 'fresh-tenant', name)).resolves.toBe(
          true
        );
      }
    });

    it('isFeatureEnabled with empty tenantId resolves to the default', async () => {
      const { data } = makeMemoryAdapter();
      // The middleware passes through requests with no tenant context;
      // this contract documents that an empty tenantId never blocks.
      await expect(isFeatureEnabled(data, '', 'export')).resolves.toBe(
        DEFAULT_FEATURE_FLAGS.export
      );
    });

    it('treats an existing doc with a missing flag as default-on for that flag', async () => {
      const { data, store } = makeMemoryAdapter();
      // Persist a doc that only overrides one flag; the others must
      // continue to read as defaults (back-compat for new features added
      // after a tenant's doc was first written).
      const partial: TenantFeaturesConfigRecord = {
        tenantId: 'tenant-partial',
        flags: { export: false },
        updatedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
        updatedBy: 'api-key-001',
      };
      store
        .get(TENANT_FEATURES_CONFIG_COLLECTION) ??
        store.set(TENANT_FEATURES_CONFIG_COLLECTION, new Map());
      store
        .get(TENANT_FEATURES_CONFIG_COLLECTION)!
        .set('tenant-partial', partial);

      const flags = await getEffectiveFeatureFlags(data, 'tenant-partial');
      expect(flags.export).toBe(false);
      // Every other flag remains default-on.
      for (const name of FEATURE_FLAG_NAMES) {
        if (name === 'export') continue;
        expect(flags[name]).toBe(true);
      }
    });
  });

  describe('mergeWithDefaults', () => {
    it('returns defaults when given null', () => {
      expect(mergeWithDefaults(null)).toEqual(DEFAULT_FEATURE_FLAGS);
    });

    it('overrides only the supplied keys', () => {
      const merged = mergeWithDefaults({ sharing: false, plugins: false });
      expect(merged.sharing).toBe(false);
      expect(merged.plugins).toBe(false);
      expect(merged.smartAlbums).toBe(true);
      expect(merged.export).toBe(true);
      expect(merged.bulkOps).toBe(true);
    });

    it('ignores non-boolean values', () => {
      const merged = mergeWithDefaults({
        // @ts-expect-error \u2014 deliberately exercising the defensive branch
        sharing: 'yes',
      });
      expect(merged.sharing).toBe(true);
    });
  });

  describe('patchTenantFeatures', () => {
    it('writes a new doc when none exists and reports every transition vs. defaults', async () => {
      const { data, store } = makeMemoryAdapter();
      const result = await patchTenantFeatures(data, {
        tenantId: 'tenant-x',
        patch: { export: false, sharing: false },
        actor: 'tak_abc123',
      });

      const stored = store
        .get(TENANT_FEATURES_CONFIG_COLLECTION)
        ?.get('tenant-x') as TenantFeaturesConfigRecord;
      expect(stored).toBeDefined();
      expect(stored.flags).toEqual({ export: false, sharing: false });
      expect(stored.updatedBy).toBe('tak_abc123');

      // `changes` enumerates flags whose effective value transitioned.
      // Before: defaults (all true). After: export=false, sharing=false.
      const changedNames = new Set(result.changes.map((c) => c.feature));
      expect(changedNames).toEqual(new Set(['export', 'sharing']));
      for (const change of result.changes) {
        expect(change.oldValue).toBe(true);
        expect(change.newValue).toBe(false);
      }
    });

    it('returns an empty `changes` array when the patch is a no-op', async () => {
      const { data } = makeMemoryAdapter();
      // First mutation: flips a flag.
      await patchTenantFeatures(data, {
        tenantId: 'tenant-y',
        patch: { plugins: false },
      });
      // Bust the cache so the next read sees the just-written doc and
      // can compare apples-to-apples.
      invalidateTenantFeaturesCache('tenant-y');

      // Second mutation: re-asserts the same value. No transition.
      const result = await patchTenantFeatures(data, {
        tenantId: 'tenant-y',
        patch: { plugins: false },
      });
      expect(result.changes).toEqual([]);
    });

    it('ignores unknown keys defensively', async () => {
      const { data, store } = makeMemoryAdapter();
      await patchTenantFeatures(data, {
        tenantId: 'tenant-z',
        // @ts-expect-error \u2014 simulating a typo / deprecated flag
        patch: { sharing: false, somethingDeprecated: true },
      });
      const stored = store
        .get(TENANT_FEATURES_CONFIG_COLLECTION)
        ?.get('tenant-z') as TenantFeaturesConfigRecord;
      expect(stored.flags).toEqual({ sharing: false });
      // Unknown key did NOT leak into the stored map.
      expect(Object.keys(stored.flags)).not.toContain('somethingDeprecated');
    });

    it('rejects missing tenantId', async () => {
      const { data } = makeMemoryAdapter();
      await expect(
        patchTenantFeatures(data, { tenantId: '', patch: { export: false } })
      ).rejects.toThrow(/tenantId/);
    });
  });

  describe('TTL cache', () => {
    it('caches fetchTenantFeaturesConfig and busts on patch', async () => {
      const { data } = makeMemoryAdapter();
      const fetchSpy = data.fetchData as ReturnType<typeof vi.fn>;

      // Cold read \u2014 hits storage.
      await fetchTenantFeaturesConfig(data, 'tenant-c');
      const coldCalls = fetchSpy.mock.calls.length;

      // Warm read \u2014 served from cache, no extra fetch.
      await fetchTenantFeaturesConfig(data, 'tenant-c');
      expect(fetchSpy.mock.calls.length).toBe(coldCalls);

      // A patch invalidates the cache, so the next read must hit storage.
      await patchTenantFeatures(data, {
        tenantId: 'tenant-c',
        patch: { plugins: false },
      });
      await fetchTenantFeaturesConfig(data, 'tenant-c');
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(coldCalls);
    });
  });
});
