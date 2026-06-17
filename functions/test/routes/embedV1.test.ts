import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import {
  createEmbedV1Router,
  createEmbedCspMiddleware,
  loadAllowedOriginsForTenant,
  embedConfigWithDefaults,
  sanitizeOrigin,
  EMBED_CONFIG_COLLECTION,
  type EmbedConfigRecord,
} from '../../src/routes/embedV1.js';
import type { DataAdapter } from '../../src/adapters/data/DataAdapter.js';

function makeAdapter(
  initial: Record<string, EmbedConfigRecord> = {}
): DataAdapter & { _store: Record<string, EmbedConfigRecord>; _audit: Record<string, unknown> } {
  const store: Record<string, EmbedConfigRecord> = { ...initial };
  const auditStore: Record<string, unknown> = {};
  return {
    _store: store,
    _audit: auditStore,
    async storeData(collection, id, data) {
      if (collection === EMBED_CONFIG_COLLECTION) store[id] = data as EmbedConfigRecord;
      else auditStore[id] = data;
    },
    async fetchData(collection, id) {
      if (collection === EMBED_CONFIG_COLLECTION) return (store[id] as any) ?? null;
      return (auditStore[id] as any) ?? null;
    },
    async queryData() { return []; },
    async updateData() {},
    async deleteData() {},
    async exists(collection, id) {
      return collection === EMBED_CONFIG_COLLECTION ? id in store : id in auditStore;
    },
    async listIds() { return []; },
    async getPhoto() { return null; },
  } as unknown as DataAdapter & {
    _store: Record<string, EmbedConfigRecord>;
    _audit: Record<string, unknown>;
  };
}

async function request(
  app: express.Express,
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const init: RequestInit = {
        method,
        headers: { 'content-type': 'application/json', ...extraHeaders },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      fetch(`http://127.0.0.1:${port}${path}`, init)
        .then(async (res) => {
          const text = await res.text();
          let parsed: any = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => { headers[k] = v; });
          server.close();
          resolve({ status: res.status, body: parsed, headers });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('sanitizeOrigin', () => {
  it('accepts https origins', () => {
    expect(sanitizeOrigin('https://app.example.com')).toBe('https://app.example.com');
    expect(sanitizeOrigin('https://app.example.com:8443')).toBe('https://app.example.com:8443');
    expect(sanitizeOrigin('  https://app.example.com  ')).toBe('https://app.example.com');
  });

  it('accepts http for localhost only', () => {
    expect(sanitizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(sanitizeOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(sanitizeOrigin('http://sub.localhost')).toBe('http://sub.localhost');
    expect(sanitizeOrigin('http://example.com')).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(sanitizeOrigin('javascript:alert(1)')).toBeNull();
    expect(sanitizeOrigin('data:text/html,foo')).toBeNull();
    expect(sanitizeOrigin('file:///etc/passwd')).toBeNull();
    expect(sanitizeOrigin('ftp://example.com')).toBeNull();
  });

  it('rejects strings with paths, queries, fragments, or auth', () => {
    expect(sanitizeOrigin('https://example.com/path')).toBeNull();
    expect(sanitizeOrigin('https://example.com/?q=1')).toBeNull();
    expect(sanitizeOrigin('https://example.com/#hash')).toBeNull();
    expect(sanitizeOrigin('https://user:pass@example.com')).toBeNull();
  });

  it('rejects header-injection / CSP-poison attempts', () => {
    expect(sanitizeOrigin("https://example.com'")).toBeNull();
    expect(sanitizeOrigin('https://example.com; script-src *')).toBeNull();
    expect(sanitizeOrigin('https://example.com\r\nX-Inject: 1')).toBeNull();
    expect(sanitizeOrigin('https://example.com "evil"')).toBeNull();
    expect(sanitizeOrigin('')).toBeNull();
    expect(sanitizeOrigin(null)).toBeNull();
    expect(sanitizeOrigin(42)).toBeNull();
  });
});

describe('embedConfigWithDefaults', () => {
  it('returns an empty list when no doc exists (embed disabled)', () => {
    const ec = embedConfigWithDefaults('acme', null);
    expect(ec.tenantId).toBe('acme');
    expect(ec.origins).toEqual([]);
  });

  it('strips invalid entries and dedupes', () => {
    const ec = embedConfigWithDefaults('acme', {
      origins: [
        'https://a.example.com',
        'https://a.example.com',
        'javascript:bad',
        'https://b.example.com/path',
        'https://c.example.com',
      ],
    } as any);
    expect(ec.origins).toEqual([
      'https://a.example.com',
      'https://c.example.com',
    ]);
  });
});

describe('GET /:tenantId/embed/allowed-origins', () => {
  let app: express.Express;
  let adapter: ReturnType<typeof makeAdapter>;

  beforeEach(() => {
    adapter = makeAdapter();
    app = express();
    app.use(express.json());
    app.use(
      '/api/v1/tenants',
      createEmbedV1Router(adapter, { canWriteEmbedConfig: () => true })
    );
  });

  it('returns an empty allowedOrigins list for new tenants', async () => {
    const res = await request(app, 'GET', '/api/v1/tenants/acme/embed/allowed-origins');
    expect(res.status).toBe(200);
    expect(res.body.embed.tenantId).toBe('acme');
    expect(res.body.embed.allowedOrigins).toEqual([]);
  });

  it('returns 400 for an invalid tenant id', async () => {
    const res = await request(app, 'GET', '/api/v1/tenants/has%20space/embed/allowed-origins');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TENANT_ID');
  });

  it('returns 403 when the auth gate denies the caller', async () => {
    const local = express();
    local.use(express.json());
    local.use(
      '/api/v1/tenants',
      createEmbedV1Router(adapter, { canWriteEmbedConfig: () => false })
    );
    const res = await request(local, 'GET', '/api/v1/tenants/acme/embed/allowed-origins');
    expect(res.status).toBe(403);
  });
});

describe('PUT /:tenantId/embed/allowed-origins', () => {
  it('persists valid origins and emits an audit event', async () => {
    const adapter = makeAdapter();
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/tenants',
      createEmbedV1Router(adapter, { canWriteEmbedConfig: () => true })
    );
    const res = await request(app, 'PUT', '/api/v1/tenants/acme/embed/allowed-origins', {
      origins: ['https://host-a.example.com', 'https://host-b.example.com'],
    });
    expect(res.status).toBe(200);
    expect(res.body.embed.allowedOrigins).toEqual([
      'https://host-a.example.com',
      'https://host-b.example.com',
    ]);
    expect(adapter._store.acme.origins).toHaveLength(2);
    // Audit event recorded under a uuid key.
    const auditValues = Object.values(adapter._audit);
    expect(auditValues.length).toBeGreaterThan(0);
    const auditEvent = auditValues[0] as any;
    expect(auditEvent.eventType).toBe('embed.allowed_origins.updated');
    expect(auditEvent.metadata.embedDisabled).toBe(false);
  });

  it('accepts an empty list (embed disabled)', async () => {
    const adapter = makeAdapter();
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/tenants',
      createEmbedV1Router(adapter, { canWriteEmbedConfig: () => true })
    );
    const res = await request(app, 'PUT', '/api/v1/tenants/acme/embed/allowed-origins', {
      origins: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.embed.allowedOrigins).toEqual([]);
    expect(adapter._store.acme.origins).toEqual([]);
  });

  it('rejects bodies containing a non-origin string', async () => {
    const adapter = makeAdapter();
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/tenants',
      createEmbedV1Router(adapter, { canWriteEmbedConfig: () => true })
    );
    const res = await request(app, 'PUT', '/api/v1/tenants/acme/embed/allowed-origins', {
      origins: ['https://ok.example.com', 'javascript:bad'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('returns 403 when the auth gate denies', async () => {
    const adapter = makeAdapter();
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/tenants',
      createEmbedV1Router(adapter, { canWriteEmbedConfig: () => false })
    );
    const res = await request(app, 'PUT', '/api/v1/tenants/acme/embed/allowed-origins', {
      origins: ['https://host-a.example.com'],
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /:tenantId/embed/csp-report', () => {
  it('emits embed.origin_blocked when a frame-ancestors violation is reported', async () => {
    const adapter = makeAdapter();
    const emit = vi.fn();
    const app = express();
    app.use(express.json({ type: ['application/json', 'application/csp-report'] }));
    app.use((req, _res, next) => {
      (req.app.locals as any).meteringBus = { emit };
      next();
    });
    app.use(
      '/api/v1/tenants',
      createEmbedV1Router(adapter, { canWriteEmbedConfig: () => true })
    );
    const res = await request(
      app,
      'POST',
      '/api/v1/tenants/acme/embed/csp-report',
      {
        'csp-report': {
          'violated-directive': 'frame-ancestors',
          'blocked-uri': 'https://evil.example.com',
          'document-uri': 'https://app.aurapix.com/photos',
        },
      },
      { 'content-type': 'application/csp-report' }
    );
    expect(res.status).toBe(204);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'acme',
      type: 'embed.origin_blocked',
    }));
  });

  it('does not emit for non-frame-ancestors violations', async () => {
    const adapter = makeAdapter();
    const emit = vi.fn();
    const app = express();
    app.use(express.json({ type: ['application/json', 'application/csp-report'] }));
    app.use((req, _res, next) => {
      (req.app.locals as any).meteringBus = { emit };
      next();
    });
    app.use(
      '/api/v1/tenants',
      createEmbedV1Router(adapter, { canWriteEmbedConfig: () => true })
    );
    const res = await request(
      app,
      'POST',
      '/api/v1/tenants/acme/embed/csp-report',
      { 'csp-report': { 'violated-directive': 'script-src' } },
      { 'content-type': 'application/csp-report' }
    );
    expect(res.status).toBe(204);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('createEmbedCspMiddleware', () => {
  it('emits frame-ancestors=none + X-Frame-Options=DENY when no origins are allowed', async () => {
    const middleware = createEmbedCspMiddleware({
      tenantFromReq: () => 'acme',
      loadOrigins: async () => [],
    });
    const app = express();
    app.use(middleware);
    app.get('/x', (_req, res) => res.json({ ok: true }));

    const res = await request(app, 'GET', '/x');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('emits frame-ancestors=<list> when origins are configured', async () => {
    const middleware = createEmbedCspMiddleware({
      tenantFromReq: () => 'acme',
      loadOrigins: async () => ['https://host-a.example.com', 'https://host-b.example.com'],
    });
    const app = express();
    app.use(middleware);
    app.get('/x', (_req, res) => res.json({ ok: true }));

    const res = await request(app, 'GET', '/x');
    expect(res.headers['content-security-policy']).toContain(
      'frame-ancestors https://host-a.example.com https://host-b.example.com'
    );
  });

  it('is a no-op when no tenant can be resolved', async () => {
    const middleware = createEmbedCspMiddleware({
      tenantFromReq: () => null,
      loadOrigins: async () => ['https://host.example.com'],
    });
    const app = express();
    app.use(middleware);
    app.get('/x', (_req, res) => res.json({ ok: true }));

    const res = await request(app, 'GET', '/x');
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBeUndefined();
  });

  it('emits embed.session_started (debounced) when an allowed parent frames the page', async () => {
    const emit = vi.fn();
    const middleware = createEmbedCspMiddleware({
      tenantFromReq: () => 'acme',
      loadOrigins: async () => ['https://host.example.com'],
      meteringBus: { emit },
    });
    const app = express();
    app.use(middleware);
    app.get('/x', (_req, res) => res.json({ ok: true }));

    const headers = {
      'referer': 'https://host.example.com/page',
      'sec-fetch-dest': 'iframe',
      'user-agent': 'jest-test',
    };
    await request(app, 'GET', '/x', undefined, headers);
    await request(app, 'GET', '/x', undefined, headers);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'acme',
      type: 'embed.session_started',
      meta: expect.objectContaining({ origin: 'https://host.example.com' }),
    }));
  });

  it('does not emit embed.session_started when the parent origin is not allowed', async () => {
    const emit = vi.fn();
    const middleware = createEmbedCspMiddleware({
      tenantFromReq: () => 'acme',
      loadOrigins: async () => ['https://host.example.com'],
      meteringBus: { emit },
    });
    const app = express();
    app.use(middleware);
    app.get('/x', (_req, res) => res.json({ ok: true }));

    await request(app, 'GET', '/x', undefined, {
      'referer': 'https://evil.example.com/page',
      'sec-fetch-dest': 'iframe',
    });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('loadAllowedOriginsForTenant', () => {
  it('returns [] for an unknown tenant', async () => {
    const adapter = makeAdapter();
    expect(await loadAllowedOriginsForTenant(adapter, 'unknown')).toEqual([]);
  });

  it('returns the stored origins for a known tenant', async () => {
    const adapter = makeAdapter({
      acme: {
        tenantId: 'acme',
        origins: ['https://host-a.example.com'],
        updatedAt: '2025-01-01T00:00:00Z',
      },
    });
    expect(await loadAllowedOriginsForTenant(adapter, 'acme')).toEqual([
      'https://host-a.example.com',
    ]);
  });
});
