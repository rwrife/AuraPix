import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import {
  createBrandingV1Router,
  sanitizeHexColor,
  brandingWithDefaults,
  loadBrandingTokensForEmbed,
  BRANDING_COLLECTION,
  DEFAULT_BRANDING,
  type BrandingRecord,
} from '../../src/routes/brandingV1.js';
import type { DataAdapter } from '../../src/adapters/data/DataAdapter.js';

function makeAdapter(initial: Record<string, BrandingRecord> = {}): DataAdapter & { _store: Record<string, BrandingRecord> } {
  const store: Record<string, BrandingRecord> = { ...initial };
  const auditStore: Record<string, unknown> = {};
  return {
    _store: store,
    async storeData(collection, id, data) {
      if (collection === BRANDING_COLLECTION) store[id] = data as BrandingRecord;
      else auditStore[id] = data;
    },
    async fetchData(collection, id) {
      if (collection === BRANDING_COLLECTION) return (store[id] as any) ?? null;
      return (auditStore[id] as any) ?? null;
    },
    async queryData() { return []; },
    async updateData() {},
    async deleteData() {},
    async exists(collection, id) { return collection === BRANDING_COLLECTION ? id in store : id in auditStore; },
    async listIds() { return []; },
    async getPhoto() { return null; },
  } as unknown as DataAdapter & { _store: Record<string, BrandingRecord> };
}

async function request(
  app: express.Express,
  method: 'GET' | 'PUT',
  path: string,
  body?: unknown
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
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

describe('sanitizeHexColor', () => {
  it('accepts #RRGGBB', () => {
    expect(sanitizeHexColor('#ff00aa')).toBe('#ff00aa');
    expect(sanitizeHexColor('#000000')).toBe('#000000');
  });

  it('accepts #RGB shorthand', () => {
    expect(sanitizeHexColor('#abc')).toBe('#abc');
  });

  it('trims whitespace', () => {
    expect(sanitizeHexColor('  #112233  ')).toBe('#112233');
  });

  it('rejects non-hex values', () => {
    expect(sanitizeHexColor('red')).toBeNull();
    expect(sanitizeHexColor('rgb(255,0,0)')).toBeNull();
    expect(sanitizeHexColor('hsl(0,100%,50%)')).toBeNull();
    expect(sanitizeHexColor('#12')).toBeNull();
    expect(sanitizeHexColor('#1234')).toBeNull();
    expect(sanitizeHexColor('#ggg')).toBeNull();
    expect(sanitizeHexColor('#112233; }body{color:red')).toBeNull();
    expect(sanitizeHexColor(null)).toBeNull();
    expect(sanitizeHexColor(undefined)).toBeNull();
    expect(sanitizeHexColor(42)).toBeNull();
    expect(sanitizeHexColor('')).toBeNull();
  });
});

describe('brandingWithDefaults', () => {
  it('returns defaults when no doc exists', () => {
    const b = brandingWithDefaults('tenantA', null);
    expect(b.tenantId).toBe('tenantA');
    expect(b.appName).toBe(DEFAULT_BRANDING.appName);
    expect(b.primaryColor).toBe(DEFAULT_BRANDING.primaryColor);
    expect(b.accentColor).toBe(DEFAULT_BRANDING.accentColor);
  });

  it('preserves stored values', () => {
    const b = brandingWithDefaults('t1', {
      appName: 'Custom', primaryColor: '#111111', accentColor: '#222222', updatedAt: '2025-01-01T00:00:00.000Z',
    } as any);
    expect(b.appName).toBe('Custom');
    expect(b.primaryColor).toBe('#111111');
  });
});

describe('GET /:tenantId/branding contract', () => {
  let app: express.Express;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/tenants', createBrandingV1Router(makeAdapter()));
  });

  it('returns the BrandingEnvelope shape with defaults when missing', async () => {
    const res = await request(app, 'GET', '/api/v1/tenants/acme/branding');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('branding');
    expect(res.body.branding).toMatchObject({
      tenantId: 'acme',
      appName: expect.any(String),
      primaryColor: expect.stringMatching(/^#[0-9a-fA-F]{3,6}$/),
      accentColor: expect.stringMatching(/^#[0-9a-fA-F]{3,6}$/),
      updatedAt: expect.any(String),
    });
    expect(res.headers['cache-control']).toContain('public');
  });

  it('rejects invalid tenantId', async () => {
    const res = await request(app, 'GET', '/api/v1/tenants/has%20space/branding');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TENANT_ID');
  });

  it('returns stored branding when present', async () => {
    const adapter = makeAdapter({
      acme: {
        tenantId: 'acme', appName: 'Acme', primaryColor: '#abcdef', accentColor: '#123456',
        logoUrl: 'https://cdn.example.com/logo.png', updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });
    const localApp = express();
    localApp.use(express.json());
    localApp.use('/api/v1/tenants', createBrandingV1Router(adapter));
    const res = await request(localApp, 'GET', '/api/v1/tenants/acme/branding');
    expect(res.status).toBe(200);
    expect(res.body.branding.appName).toBe('Acme');
    expect(res.body.branding.logoUrl).toBe('https://cdn.example.com/logo.png');
  });
});

describe('PUT /:tenantId/branding', () => {
  it('requires authorization (returns 403 when canWrite returns false)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/tenants', createBrandingV1Router(makeAdapter(), { canWriteBranding: () => false }));
    const res = await request(app, 'PUT', '/api/v1/tenants/acme/branding', {
      appName: 'X', primaryColor: '#111111', accentColor: '#222222',
    });
    expect(res.status).toBe(403);
  });

  it('rejects non-hex colors', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/tenants', createBrandingV1Router(makeAdapter(), { canWriteBranding: () => true }));
    const res = await request(app, 'PUT', '/api/v1/tenants/acme/branding', {
      appName: 'X', primaryColor: 'red', accentColor: '#222222',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('persists and returns updated branding when authorized', async () => {
    const adapter = makeAdapter();
    const app = express();
    app.use(express.json());
    app.use('/api/v1/tenants', createBrandingV1Router(adapter, { canWriteBranding: () => true }));
    const res = await request(app, 'PUT', '/api/v1/tenants/acme/branding', {
      appName: 'Acme', primaryColor: '#abcdef', accentColor: '#123456',
      logoUrl: 'https://cdn.example.com/l.png',
    });
    expect(res.status).toBe(200);
    expect(res.body.branding.appName).toBe('Acme');
    expect(adapter._store.acme.primaryColor).toBe('#abcdef');
  });
});

describe('loadBrandingTokensForEmbed (issue #187)', () => {
  it('returns null for an unknown tenant', async () => {
    const adapter = makeAdapter();
    expect(await loadBrandingTokensForEmbed(adapter, 'unknown')).toBeNull();
  });

  it('returns null when only default colors and no logo are configured', async () => {
    // Tenant has a doc but every field is the default — emitting branding
    // tokens here would be noise. The host should fall back to its own
    // defaults.
    const adapter = makeAdapter({
      acme: {
        tenantId: 'acme',
        appName: DEFAULT_BRANDING.appName,
        primaryColor: DEFAULT_BRANDING.primaryColor,
        accentColor: DEFAULT_BRANDING.accentColor,
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });
    expect(await loadBrandingTokensForEmbed(adapter, 'acme')).toBeNull();
  });

  it('returns only non-default tokens for a partially-branded tenant', async () => {
    const adapter = makeAdapter({
      acme: {
        tenantId: 'acme',
        appName: 'Acme',
        primaryColor: '#abcdef',
        accentColor: DEFAULT_BRANDING.accentColor,
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });
    const tokens = await loadBrandingTokensForEmbed(adapter, 'acme');
    expect(tokens).toEqual({ primaryColor: '#abcdef' });
  });

  it('returns logoUrl independently of the default-color comparison', async () => {
    const adapter = makeAdapter({
      acme: {
        tenantId: 'acme',
        appName: DEFAULT_BRANDING.appName,
        primaryColor: DEFAULT_BRANDING.primaryColor,
        accentColor: DEFAULT_BRANDING.accentColor,
        logoUrl: 'https://cdn.example.com/logo.svg',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });
    const tokens = await loadBrandingTokensForEmbed(adapter, 'acme');
    expect(tokens).toEqual({ logoUrl: 'https://cdn.example.com/logo.svg' });
  });

  it('returns all non-default tokens for a fully-branded tenant', async () => {
    const adapter = makeAdapter({
      acme: {
        tenantId: 'acme',
        appName: 'Acme',
        primaryColor: '#abcdef',
        accentColor: '#123456',
        logoUrl: 'https://cdn.example.com/logo.svg',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });
    const tokens = await loadBrandingTokensForEmbed(adapter, 'acme');
    expect(tokens).toEqual({
      primaryColor: '#abcdef',
      accentColor: '#123456',
      logoUrl: 'https://cdn.example.com/logo.svg',
    });
  });

  it('never leaks internal fields (tenantId, updatedAt, appName, faviconUrl)', async () => {
    // Acceptance criteria: snapshot test on payload shape — no
    // secret/internal fields leaked.
    const adapter = makeAdapter({
      acme: {
        tenantId: 'acme',
        appName: 'Acme',
        primaryColor: '#abcdef',
        accentColor: '#123456',
        logoUrl: 'https://cdn.example.com/logo.svg',
        faviconUrl: 'https://cdn.example.com/favicon.ico',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });
    const tokens = await loadBrandingTokensForEmbed(adapter, 'acme');
    expect(tokens).not.toBeNull();
    expect(Object.keys(tokens!).sort()).toEqual(['accentColor', 'logoUrl', 'primaryColor']);
    for (const forbidden of ['tenantId', 'updatedAt', 'appName', 'faviconUrl']) {
      expect((tokens as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });

  it('rejects invalid tenant ids without hitting the adapter', async () => {
    const adapter = makeAdapter({
      acme: {
        tenantId: 'acme', appName: 'Acme',
        primaryColor: '#abcdef', accentColor: '#123456',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });
    expect(await loadBrandingTokensForEmbed(adapter, 'has space')).toBeNull();
  });

  it('ignores malformed stored colors (defensive)', async () => {
    const adapter = makeAdapter({
      acme: {
        tenantId: 'acme',
        appName: 'Acme',
        // Intentionally bogus values — stored data corruption shouldn't
        // leak through to the embed handshake.
        primaryColor: 'rgb(255,0,0)',
        accentColor: '#123',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });
    const tokens = await loadBrandingTokensForEmbed(adapter, 'acme');
    // accentColor #123 is a valid hex AND differs from default, so it
    // flows through; primaryColor is dropped.
    expect(tokens).toEqual({ accentColor: '#123' });
  });
});
