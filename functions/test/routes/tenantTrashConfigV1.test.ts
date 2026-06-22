import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createTenantTrashConfigRouter } from '../../src/routes/tenantTrashConfigV1.js';
import type { DataAdapter, QueryFilter } from '../../src/adapters/data/DataAdapter.js';
import {
  setMeteringBus,
  setWebhookDeliveryStore,
} from '../../src/services/metering/index.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../../src/services/metering/MeteringBus.js';
import { __resetTenantFeaturesCacheForTests } from '../../src/services/host/tenantFeaturesConfigService.js';
import {
  TENANT_FEATURES_CONFIG_COLLECTION,
  type TenantFeaturesConfigRecord,
} from '../../src/models/TenantFeaturesConfig.js';
import { AUDIT_EVENTS_COLLECTION } from '../../src/services/audit/AuditService.js';
import type { TenantApiKeyScope } from '../../src/models/TenantApiKey.js';

/**
 * Route tests for `/v1/tenants/:tenantId/config/trash` (issue #183).
 *
 * Mirrors the auth-shim pattern used in `tenantOffboardingV1.test.ts`:
 * an in-process express app installs a fake `req.tenant` based on
 * `x-test-tenant` / `x-test-scopes` headers, then mounts the real
 * router so we exercise the actual guards and handlers.
 */

class MemData implements DataAdapter {
  public docs = new Map<string, Map<string, any>>();
  private col(c: string) {
    let m = this.docs.get(c);
    if (!m) { m = new Map(); this.docs.set(c, m); }
    return m;
  }
  async storeData(c: string, id: string, d: any) { this.col(c).set(id, d); }
  async fetchData(c: string, id: string) { return this.col(c).get(id) ?? null; }
  async queryData(c: string, filters: QueryFilter[]) {
    return Array.from(this.col(c).values()).filter((d) =>
      filters.every((f) => (d as any)[f.field] === f.value)
    );
  }
  async updateData(c: string, id: string, u: any) {
    const cur = this.col(c).get(id);
    this.col(c).set(id, { ...cur, ...u });
  }
  async deleteData(c: string, id: string) { this.col(c).delete(id); }
  async exists(c: string, id: string) { return this.col(c).has(id); }
  async listIds(c: string) { return Array.from(this.col(c).keys()); }
  async getPhoto() { return null; }
}

class CapturingSink implements MeteringSink {
  batches: NormalizedMeteringEvent[][] = [];
  async deliver(events: NormalizedMeteringEvent[]) { this.batches.push(events); }
  all() { return this.batches.flat(); }
}

function makeApp(data: DataAdapter, deploymentDefault = 30): express.Express {
  const app = express();
  app.use(express.json());
  // Fake auth shim — synth req.tenant from headers.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const id = req.header('x-test-tenant');
    const scopes = req.header('x-test-scopes');
    if (id) {
      req.tenant = {
        id,
        scopes: ((scopes ?? '').split(',').filter(Boolean) as TenantApiKeyScope[]),
        keyId: 'tak_test001',
      };
    }
    next();
  });
  app.use(
    '/v1/tenants',
    createTenantTrashConfigRouter({
      dataAdapter: data,
      resolveDeploymentDefault: () => deploymentDefault,
    })
  );
  return app;
}

async function request(
  app: express.Express,
  method: 'GET' | 'PATCH',
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const init: RequestInit = {
        method,
        headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      fetch(`http://127.0.0.1:${port}${path}`, init)
        .then(async (res) => {
          const text = await res.text();
          let parsed: any = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
          server.close();
          resolve({ status: res.status, body: parsed });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('tenant trash retention config routes (issue #183)', () => {
  let data: MemData;
  let app: express.Express;
  let sink: CapturingSink;

  beforeEach(() => {
    data = new MemData();
    app = makeApp(data);
    sink = new CapturingSink();
    setWebhookDeliveryStore(null);
    setMeteringBus(new MeteringBus({ sink, flushIntervalMs: 5, maxBatchSize: 50 }));
    __resetTenantFeaturesCacheForTests();
  });

  afterEach(() => {
    setMeteringBus(null);
  });

  describe('auth + scope guard', () => {
    it('401 without host API key', async () => {
      const res = await request(app, 'GET', '/v1/tenants/t1/config/trash');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('HOST_API_KEY_REQUIRED');
    });

    it('403 on cross-tenant request', async () => {
      const res = await request(app, 'GET', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't2', 'x-test-scopes': 'tenant.config' },
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CROSS_TENANT_FORBIDDEN');
    });

    it('403 without tenant.config scope', async () => {
      const res = await request(app, 'GET', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'usage.read' },
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
    });

    it('401 on PATCH without host API key', async () => {
      const res = await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
        body: { retentionDays: 7 },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET', () => {
    it('returns the deployment default when no override is set', async () => {
      const res = await request(app, 'GET', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        tenantId: 't1',
        retentionDays: 30,
        override: null,
        deploymentDefault: 30,
        source: 'deployment',
      });
    });

    it('returns the override when set', async () => {
      const rec: TenantFeaturesConfigRecord = {
        tenantId: 't1',
        flags: {},
        trashRetentionDays: 7,
        updatedAt: '2024-01-01T00:00:00Z',
        updatedBy: 'tak_abc',
      };
      await data.storeData(TENANT_FEATURES_CONFIG_COLLECTION, 't1', rec);
      const res = await request(app, 'GET', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
      });
      expect(res.status).toBe(200);
      expect(res.body.retentionDays).toBe(7);
      expect(res.body.override).toBe(7);
      expect(res.body.source).toBe('tenant');
      expect(res.body.updatedBy).toBe('tak_abc');
    });
  });

  describe('PATCH', () => {
    it('sets a per-tenant override and returns the new effective value', async () => {
      const res = await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
        body: { retentionDays: 7 },
      });
      expect(res.status).toBe(200);
      expect(res.body.retentionDays).toBe(7);
      expect(res.body.override).toBe(7);
      expect(res.body.source).toBe('tenant');
      expect(res.body.changed).toBe(true);
      expect(res.body.previous).toBeNull();

      // Persisted.
      const stored = (await data.fetchData(
        TENANT_FEATURES_CONFIG_COLLECTION,
        't1'
      )) as TenantFeaturesConfigRecord;
      expect(stored.trashRetentionDays).toBe(7);
    });

    it('clears the override on null', async () => {
      await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
        body: { retentionDays: 21 },
      });
      const res = await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
        body: { retentionDays: null },
      });
      expect(res.status).toBe(200);
      expect(res.body.override).toBeNull();
      expect(res.body.retentionDays).toBe(30);
      expect(res.body.source).toBe('deployment');
      expect(res.body.previous).toBe(21);
    });

    it('rejects out-of-range values (0, negative, >365)', async () => {
      for (const v of [0, -1, 366, 1000]) {
        const res = await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
          headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
          body: { retentionDays: v },
        });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_BODY');
      }
    });

    it('rejects non-integer values', async () => {
      const res = await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
        body: { retentionDays: 3.5 },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_BODY');
    });

    it('rejects unknown body keys (strict)', async () => {
      const res = await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
        body: { retentionDays: 7, somethingElse: true },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_BODY');
    });

    it('emits feature.flag_changed with flag="trash.retentionDays" on transition', async () => {
      const res = await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
        body: { retentionDays: 90 },
      });
      expect(res.status).toBe(200);

      // Allow MeteringBus flushInterval (5ms) to drain.
      await new Promise((r) => setTimeout(r, 30));
      const events = sink.all();
      const flagEvent = events.find(
        (e) =>
          e.type === 'feature.flag_changed' &&
          (e.meta as any)?.feature === 'trash.retentionDays'
      );
      expect(flagEvent).toBeDefined();
      expect((flagEvent!.meta as any).oldValue).toBeNull();
      expect((flagEvent!.meta as any).newValue).toBe(90);
    });

    it('does NOT emit feature.flag_changed when the value is unchanged', async () => {
      // First PATCH sets the value.
      await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
        body: { retentionDays: 60 },
      });
      await new Promise((r) => setTimeout(r, 30));
      const before = sink
        .all()
        .filter(
          (e) =>
            e.type === 'feature.flag_changed' &&
            (e.meta as any)?.feature === 'trash.retentionDays'
        ).length;

      // Second PATCH with the same value — no transition.
      const res = await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
        body: { retentionDays: 60 },
      });
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(false);

      await new Promise((r) => setTimeout(r, 30));
      const after = sink
        .all()
        .filter(
          (e) =>
            e.type === 'feature.flag_changed' &&
            (e.meta as any)?.feature === 'trash.retentionDays'
        ).length;
      expect(after).toBe(before);
    });

    it('records an audit event on transition', async () => {
      await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
        body: { retentionDays: 14 },
      });
      const auditRecords = Array.from(
        data.docs.get(AUDIT_EVENTS_COLLECTION)?.values() ?? []
      );
      const trashAudit = auditRecords.find(
        (r: any) => r.eventType === 'tenant.config.trash.updated'
      );
      expect(trashAudit).toBeDefined();
      expect((trashAudit as any).tenantId).toBe('t1');
      expect((trashAudit as any).metadata.next).toBe(14);
      expect((trashAudit as any).metadata.previous).toBeNull();
    });

    it('does NOT record an audit event on a no-op PATCH', async () => {
      await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
        body: { retentionDays: 14 },
      });
      const before = Array.from(
        data.docs.get(AUDIT_EVENTS_COLLECTION)?.values() ?? []
      ).length;

      await request(app, 'PATCH', '/v1/tenants/t1/config/trash', {
        headers: { 'x-test-tenant': 't1', 'x-test-scopes': 'tenant.config' },
        body: { retentionDays: 14 },
      });
      const after = Array.from(
        data.docs.get(AUDIT_EVENTS_COLLECTION)?.values() ?? []
      ).length;
      expect(after).toBe(before);
    });
  });
});
