/**
 * Unit tests for the per-tenant edit-presets router (issue #197).
 *
 * Mirrors the harness pattern used in tenantStorageThresholdsV1.test.ts —
 * an in-memory DataAdapter + a small express test server that injects a
 * fake `req.tenant` / `req.user` before the router runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { createTenantEditPresetsRouter } from './tenantEditPresetsV1.js';
import type { TenantRoleResolver } from './tenantEditPresetsV1.js';
import {
  EDIT_PRESETS_COLLECTION,
  editPresetDocId,
  type EditPresetRecord,
} from '../models/EditPreset.js';
import type { Photo } from '../models/Photo.js';

interface FakeTenant {
  id: string;
  scopes: string[];
  keyId?: string;
}

function makeApp(
  data: DataAdapter,
  inject: (req: express.Request) => void = () => {},
  resolveTenantRole?: TenantRoleResolver
): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    inject(req);
    next();
  });
  const router = createTenantEditPresetsRouter({
    dataAdapter: data,
    resolveTenantRole,
  });
  app.use('/v1/tenants', router);
  app.use(errorHandler);
  return app;
}

function makeMemoryAdapter(seed: Record<string, unknown> = {}): {
  data: DataAdapter;
  store: Map<string, Map<string, unknown>>;
} {
  const store = new Map<string, Map<string, unknown>>();
  for (const [key, value] of Object.entries(seed)) {
    const [collection, id] = key.split('::');
    if (!collection || !id) continue;
    if (!store.has(collection)) store.set(collection, new Map());
    store.get(collection)!.set(id, value);
  }
  const get = (collection: string) => {
    let inner = store.get(collection);
    if (!inner) {
      inner = new Map();
      store.set(collection, inner);
    }
    return inner;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = {
    storeData: vi.fn(async (collection: string, id: string, value: unknown) => {
      get(collection).set(id, value);
    }),
    fetchData: vi.fn(async (collection: string, id: string) => {
      return get(collection).get(id) ?? null;
    }),
    queryData: vi.fn(async (collection: string, filters: unknown[]) => {
      const inner = get(collection);
      const rows = Array.from(inner.values());
      // Support only `field == value` filters (all we need here).
      const filtered = rows.filter((row) => {
        for (const f of filters as Array<{
          field: string;
          operator: string;
          value: unknown;
        }>) {
          if (f.operator === '==') {
            const r = row as Record<string, unknown>;
            if (r[f.field] !== f.value) return false;
          }
        }
        return true;
      });
      return filtered;
    }),
    updateData: vi.fn(async (collection: string, id: string, updates: Record<string, unknown>) => {
      const inner = get(collection);
      const existing = (inner.get(id) as Record<string, unknown> | undefined) ?? {};
      inner.set(id, { ...existing, ...updates });
    }),
    deleteData: vi.fn(async (collection: string, id: string) => {
      get(collection).delete(id);
    }),
    exists: vi.fn(async () => false),
    listIds: vi.fn(async (collection: string) => Array.from(get(collection).keys())),
    getPhoto: vi.fn(async () => null),
  };
  return { data: data as DataAdapter, store };
}

async function request(
  app: Express,
  method: 'get' | 'put' | 'delete' | 'post',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  const { createServer } = await import('node:http');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createServer(app as unknown as (req: any, res: any) => void);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: method.toUpperCase(),
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Build a minimal `Photo` doc for the memory store. */
function makePhoto(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 'photo-a',
    libraryId: 'lib-a',
    tenantId: 'tenant-a',
    albumIds: [],
    originalName: 'a.jpg',
    metadata: {
      width: 100,
      height: 100,
      mimeType: 'image/jpeg',
      sizeBytes: 1000,
    },
    status: 'ready',
    currentEditVersion: 0,
    editHistory: [],
    thumbnailsOutdated: false,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    ...overrides,
  } as Photo;
}

const VALID_RECIPE = {
  recipeVersion: 1,
  operations: [
    {
      type: 'adjust',
      params: { brightness: 0.1, contrast: 0.05 },
      order: 0,
    },
  ],
};

describe('createTenantEditPresetsRouter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /:tenantId/edit-presets', () => {
    it('401 when no auth context is present', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data);
      const { status } = await request(
        app,
        'post',
        '/v1/tenants/tenant-a/edit-presets',
        { name: 'Warm', recipe: VALID_RECIPE }
      );
      expect(status).toBe(401);
    });

    it('403 when host API key targets a different tenant', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-other',
          scopes: ['edit-presets.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'post',
        '/v1/tenants/tenant-a/edit-presets',
        { name: 'Warm', recipe: VALID_RECIPE }
      );
      expect(status).toBe(403);
      expect(body.error.code).toBe('CROSS_TENANT_FORBIDDEN');
    });

    it('403 when host API key lacks edit-presets.write scope', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['edit-presets.read'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'post',
        '/v1/tenants/tenant-a/edit-presets',
        { name: 'Warm', recipe: VALID_RECIPE }
      );
      expect(status).toBe(403);
      expect(body.error.code).toBe('INSUFFICIENT_SCOPE');
    });

    it('403 when a viewer user tries to create a preset', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(
        data,
        (req) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).user = { uid: 'user-1' };
        },
        async () => 'viewer'
      );
      const { status, body } = await request(
        app,
        'post',
        '/v1/tenants/tenant-a/edit-presets',
        { name: 'Warm', recipe: VALID_RECIPE }
      );
      expect(status).toBe(403);
      expect(body.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('creates a preset from a recipe', async () => {
      const { data, store } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['edit-presets.write'],
          keyId: 'tak_1',
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'post',
        '/v1/tenants/tenant-a/edit-presets',
        { name: 'Warm Tone', recipe: VALID_RECIPE }
      );
      expect(status).toBe(201);
      expect(body.tenantId).toBe('tenant-a');
      expect(body.name).toBe('Warm Tone');
      expect(body.recipe.operations).toHaveLength(1);
      expect(body.recipe.operations[0].type).toBe('adjust');
      expect(body.createdBy).toBe('tak_1');
      expect(typeof body.id).toBe('string');

      // Persisted under composite id.
      const stored = store
        .get(EDIT_PRESETS_COLLECTION)
        ?.get(editPresetDocId('tenant-a', body.id));
      expect(stored).toBeDefined();
    });

    it('rejects an invalid recipe operation', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['edit-presets.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'post',
        '/v1/tenants/tenant-a/edit-presets',
        {
          name: 'Bad',
          recipe: {
            recipeVersion: 1,
            operations: [
              { type: 'nonexistent-op', params: {}, order: 0 },
            ],
          },
        }
      );
      expect(status).toBe(400);
      expect(body.error.code).toBe('INVALID_RECIPE_OPERATIONS');
    });

    it('creates a preset from an existing photo\'s edits', async () => {
      const photo = makePhoto({
        id: 'photo-src',
        currentEditVersion: 2,
        editHistory: [
          {
            version: 1,
            recipeVersion: 1,
            createdAt: '2026-06-30T00:00:00.000Z',
            createdBy: 'user-x',
            operations: [
              { type: 'rotate', params: { degrees: 90 }, order: 0 },
            ],
          },
          {
            version: 2,
            recipeVersion: 1,
            createdAt: '2026-06-30T01:00:00.000Z',
            createdBy: 'user-x',
            operations: [
              { type: 'adjust', params: { brightness: 0.2 }, order: 0 },
            ],
          },
        ],
      });
      const { data } = makeMemoryAdapter({
        [`photos::photo-src`]: photo,
      });
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['edit-presets.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'post',
        '/v1/tenants/tenant-a/edit-presets',
        { name: 'From Photo', fromPhotoId: 'photo-src' }
      );
      expect(status).toBe(201);
      expect(body.recipe.operations).toHaveLength(1);
      expect(body.recipe.operations[0].type).toBe('adjust');
      expect(body.recipe.operations[0].params.brightness).toBe(0.2);
    });

    it('403 when fromPhotoId belongs to a different tenant', async () => {
      const photo = makePhoto({
        id: 'photo-src',
        tenantId: 'tenant-other',
        currentEditVersion: 1,
        editHistory: [
          {
            version: 1,
            recipeVersion: 1,
            createdAt: '2026-06-30T00:00:00.000Z',
            createdBy: 'user-x',
            operations: [
              { type: 'rotate', params: { degrees: 90 }, order: 0 },
            ],
          },
        ],
      });
      const { data } = makeMemoryAdapter({
        [`photos::photo-src`]: photo,
      });
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['edit-presets.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'post',
        '/v1/tenants/tenant-a/edit-presets',
        { name: 'Cross', fromPhotoId: 'photo-src' }
      );
      expect(status).toBe(403);
      expect(body.error.code).toBe('CROSS_TENANT_PHOTO_ID');
    });
  });

  describe('GET /:tenantId/edit-presets', () => {
    it('viewers may list', async () => {
      const record: EditPresetRecord = {
        id: 'p1',
        tenantId: 'tenant-a',
        name: 'Warm',
        recipe: VALID_RECIPE,
        createdBy: 'user-x',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      };
      const { data } = makeMemoryAdapter({
        [`${EDIT_PRESETS_COLLECTION}::${editPresetDocId('tenant-a', 'p1')}`]:
          record,
      });
      const app = makeApp(
        data,
        (req) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).user = { uid: 'user-1' };
        },
        async () => 'viewer'
      );
      const { status, body } = await request(
        app,
        'get',
        '/v1/tenants/tenant-a/edit-presets'
      );
      expect(status).toBe(200);
      expect(body.presets).toHaveLength(1);
      expect(body.presets[0].id).toBe('p1');
    });

    it('403 when the user is not a tenant member', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(
        data,
        (req) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).user = { uid: 'user-1' };
        },
        async () => null
      );
      const { status, body } = await request(
        app,
        'get',
        '/v1/tenants/tenant-a/edit-presets'
      );
      expect(status).toBe(403);
      expect(body.error.code).toBe('NOT_A_TENANT_MEMBER');
    });
  });

  describe('DELETE /:tenantId/edit-presets/:presetId', () => {
    it('editor may delete', async () => {
      const record: EditPresetRecord = {
        id: 'p1',
        tenantId: 'tenant-a',
        name: 'Warm',
        recipe: VALID_RECIPE,
        createdBy: 'user-x',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      };
      const { data, store } = makeMemoryAdapter({
        [`${EDIT_PRESETS_COLLECTION}::${editPresetDocId('tenant-a', 'p1')}`]:
          record,
      });
      const app = makeApp(
        data,
        (req) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).user = { uid: 'user-1' };
        },
        async () => 'editor'
      );
      const { status, body } = await request(
        app,
        'delete',
        '/v1/tenants/tenant-a/edit-presets/p1'
      );
      expect(status).toBe(200);
      expect(body.removed).toBe(true);
      expect(
        store
          .get(EDIT_PRESETS_COLLECTION)
          ?.has(editPresetDocId('tenant-a', 'p1'))
      ).toBe(false);
    });

    it('404 for unknown preset id', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(
        data,
        (req) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).user = { uid: 'user-1' };
        },
        async () => 'editor'
      );
      const { status, body } = await request(
        app,
        'delete',
        '/v1/tenants/tenant-a/edit-presets/nope'
      );
      expect(status).toBe(404);
      expect(body.error.code).toBe('EDIT_PRESET_NOT_FOUND');
    });

    it('cross-tenant delete rejects on host key', async () => {
      const record: EditPresetRecord = {
        id: 'p1',
        tenantId: 'tenant-a',
        name: 'Warm',
        recipe: VALID_RECIPE,
        createdBy: 'user-x',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      };
      const { data } = makeMemoryAdapter({
        [`${EDIT_PRESETS_COLLECTION}::${editPresetDocId('tenant-a', 'p1')}`]:
          record,
      });
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-other',
          scopes: ['edit-presets.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'delete',
        '/v1/tenants/tenant-a/edit-presets/p1'
      );
      expect(status).toBe(403);
      expect(body.error.code).toBe('CROSS_TENANT_FORBIDDEN');
    });
  });

  describe('POST /:tenantId/edit-presets/:presetId/apply', () => {
    it('rejects the whole batch when a foreign photoId is present', async () => {
      const record: EditPresetRecord = {
        id: 'p1',
        tenantId: 'tenant-a',
        name: 'Warm',
        recipe: VALID_RECIPE,
        createdBy: 'user-x',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      };
      const ours = makePhoto({ id: 'photo-a', tenantId: 'tenant-a' });
      const foreign = makePhoto({ id: 'photo-b', tenantId: 'tenant-other' });
      const { data } = makeMemoryAdapter({
        [`${EDIT_PRESETS_COLLECTION}::${editPresetDocId('tenant-a', 'p1')}`]:
          record,
        ['photos::photo-a']: ours,
        ['photos::photo-b']: foreign,
      });
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['edit-presets.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'post',
        '/v1/tenants/tenant-a/edit-presets/p1/apply',
        { photoIds: ['photo-a', 'photo-b'] }
      );
      expect(status).toBe(400);
      expect(body.error.code).toBe('CROSS_TENANT_PHOTO_ID');
    });

    it('returns per-photo status for a partial batch', async () => {
      const record: EditPresetRecord = {
        id: 'p1',
        tenantId: 'tenant-a',
        name: 'Warm',
        recipe: VALID_RECIPE,
        createdBy: 'user-x',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      };
      const ours = makePhoto({ id: 'photo-a', tenantId: 'tenant-a' });
      const { data, store } = makeMemoryAdapter({
        [`${EDIT_PRESETS_COLLECTION}::${editPresetDocId('tenant-a', 'p1')}`]:
          record,
        ['photos::photo-a']: ours,
        // photo-missing not seeded -> commit returns PHOTO_NOT_FOUND
      });
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['edit-presets.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'post',
        '/v1/tenants/tenant-a/edit-presets/p1/apply',
        { photoIds: ['photo-a', 'photo-missing'] }
      );
      expect(status).toBe(200);
      expect(body.presetId).toBe('p1');
      expect(body.requested).toBe(2);
      expect(body.applied).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.results).toHaveLength(2);
      const okItem = body.results.find(
        (r: { photoId: string }) => r.photoId === 'photo-a'
      );
      const missingItem = body.results.find(
        (r: { photoId: string }) => r.photoId === 'photo-missing'
      );
      expect(okItem.status).toBe('applied');
      expect(okItem.version).toBe(1);
      expect(missingItem.status).toBe('error');
      expect(missingItem.error.code).toBe('PHOTO_NOT_FOUND');

      // The applied photo now has a new edit version.
      const updated = store.get('photos')?.get('photo-a') as Photo | undefined;
      expect(updated?.currentEditVersion).toBe(1);
      expect(updated?.editHistory).toHaveLength(1);
      expect(updated?.thumbnailsOutdated).toBe(true);
    });

    it('413-style validation: photoIds cap enforced by Zod schema (400)', async () => {
      const record: EditPresetRecord = {
        id: 'p1',
        tenantId: 'tenant-a',
        name: 'Warm',
        recipe: VALID_RECIPE,
        createdBy: 'user-x',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      };
      const { data } = makeMemoryAdapter({
        [`${EDIT_PRESETS_COLLECTION}::${editPresetDocId('tenant-a', 'p1')}`]:
          record,
      });
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['edit-presets.write'],
        } satisfies FakeTenant;
      });
      // 201 photoIds -> exceeds cap of 200.
      const overCap = Array.from({ length: 201 }, (_, i) => `photo-${i}`);
      const { status, body } = await request(
        app,
        'post',
        '/v1/tenants/tenant-a/edit-presets/p1/apply',
        { photoIds: overCap }
      );
      expect(status).toBe(400);
      expect(body.error.code).toBe('INVALID_REQUEST_BODY');
    });

    it('404 when preset does not exist', async () => {
      const { data } = makeMemoryAdapter();
      const app = makeApp(data, (req) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).tenant = {
          id: 'tenant-a',
          scopes: ['edit-presets.write'],
        } satisfies FakeTenant;
      });
      const { status, body } = await request(
        app,
        'post',
        '/v1/tenants/tenant-a/edit-presets/nope/apply',
        { photoIds: ['photo-a'] }
      );
      expect(status).toBe(404);
      expect(body.error.code).toBe('EDIT_PRESET_NOT_FOUND');
    });
  });
});
