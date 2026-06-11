/**
 * Tests for GET /v1/tenants/:tenantId/audit-events (issue #164).
 *
 * Covers:
 *   - host-key auth: wrong-tenant rejection
 *   - filtering (action, actorId, resourceType, since/until)
 *   - opaque pageToken pagination over multiple pages
 *   - validation errors (bad pageSize, bad timestamps)
 *   - `audit.queried` metering event emission
 *   - retention floor (records older than the cap are excluded)
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { createAuditEventsV1Router } from '../../src/routes/auditEventsV1.js';
import {
  AUDIT_EVENTS_COLLECTION,
  recordAuditEvent,
  AUDIT_RETENTION_DAYS,
  type AuditEventRecord,
} from '../../src/services/audit/AuditService.js';
import type {
  DataAdapter,
  QueryFilter,
} from '../../src/adapters/data/DataAdapter.js';
import { MeteringBus, type NormalizedMeteringEvent } from '../../src/services/metering/MeteringBus.js';
import { InMemoryUsageMeteringBus } from '../../src/services/metering/UsageMeteringBus.js';
import type {
  AuthenticatedTenantContext,
} from '../../src/middleware/hostApiKeyAuth.js';

/** Minimal in-memory DataAdapter sufficient for the audit queries used here. */
function makeAdapter(): DataAdapter & {
  _all: () => AuditEventRecord[];
} {
  const store: Record<string, AuditEventRecord> = {};
  return {
    _all: () => Object.values(store),
    async storeData(_collection, id, data) {
      store[id] = data as AuditEventRecord;
    },
    async fetchData<T>(_collection: string, id: string) {
      return ((store[id] as unknown) as T) ?? null;
    },
    async queryData<T>(_collection: string, filters: QueryFilter[]) {
      return Object.values(store).filter((rec) =>
        filters.every((f) => {
          const v = (rec as unknown as Record<string, unknown>)[f.field];
          switch (f.operator) {
            case '==':
              return v === f.value;
            case '!=':
              return v !== f.value;
            case '>':
              return (v as number) > (f.value as number);
            case '>=':
              return (v as number) >= (f.value as number);
            case '<':
              return (v as number) < (f.value as number);
            case '<=':
              return (v as number) <= (f.value as number);
            default:
              return false;
          }
        })
      ) as unknown as T[];
    },
    async updateData() {},
    async deleteData() {},
    async exists() {
      return false;
    },
    async listIds() {
      return [];
    },
    async getPhoto() {
      return null;
    },
  } as unknown as DataAdapter & { _all: () => AuditEventRecord[] };
}

interface MakeAppOpts {
  adapter: DataAdapter;
  tenantCtx?: AuthenticatedTenantContext | null;
  authUserId?: string | null;
  ownsTenant?: (userId: string, tenantId: string) => Promise<boolean>;
  meteringBus?: MeteringBus;
  usageBus?: InMemoryUsageMeteringBus;
}

function makeApp(opts: MakeAppOpts): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.tenantCtx) req.tenant = opts.tenantCtx;
    if (opts.authUserId) req.user = { uid: opts.authUserId };
    next();
  });
  app.use(
    '/v1/tenants',
    createAuditEventsV1Router({
      dataAdapter: opts.adapter,
      meteringBus: opts.meteringBus,
      usageBus: opts.usageBus,
      ownsTenant: opts.ownsTenant ?? (async () => false),
    })
  );
  return app;
}

async function request(
  app: Express,
  path: string
): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      fetch(`http://127.0.0.1:${port}${path}`)
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

const tenantId = 'tenant-A';
const otherTenant = 'tenant-B';

function hostCtx(id: string): AuthenticatedTenantContext {
  return {
    id,
    scopes: ['audit.read'],
    keyId: `key-${id}`,
  };
}

describe('GET /v1/tenants/:tenantId/audit-events', () => {
  it('rejects cross-tenant access with 403 (host key bound to other tenant)', async () => {
    const adapter = makeAdapter();
    const app = makeApp({ adapter, tenantCtx: hostCtx(otherTenant) });
    const res = await request(app, `/v1/tenants/${tenantId}/audit-events`);
    expect(res.status).toBe(403);
  });

  it('returns 401 when neither user nor host key is present', async () => {
    const adapter = makeAdapter();
    const app = makeApp({ adapter, tenantCtx: null, authUserId: null });
    const res = await request(app, `/v1/tenants/${tenantId}/audit-events`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for Bearer users who do not own the tenant', async () => {
    const adapter = makeAdapter();
    const app = makeApp({
      adapter,
      authUserId: 'someone-else',
      ownsTenant: async (uid, t) => uid === 'tenant-owner' && t === tenantId,
    });
    const res = await request(app, `/v1/tenants/${tenantId}/audit-events`);
    expect(res.status).toBe(403);
  });

  it('returns 403 when host key lacks audit.read scope', async () => {
    const adapter = makeAdapter();
    const app = makeApp({
      adapter,
      tenantCtx: { id: tenantId, scopes: ['usage.read'], keyId: 'k1' },
    });
    const res = await request(app, `/v1/tenants/${tenantId}/audit-events`);
    expect(res.status).toBe(403);
    expect(res.body.error?.missing ?? res.body.missing).toEqual(['audit.read']);
  });

  it('lists tenant events sorted by occurredAt desc and excludes other tenants', async () => {
    const adapter = makeAdapter();

    // 3 events for our tenant + 1 for a different tenant
    await recordAuditEvent(adapter, {
      tenantId,
      eventType: 'branding.updated',
      actorId: 'u1',
      occurredAt: '2026-04-01T10:00:00.000Z',
    });
    await recordAuditEvent(adapter, {
      tenantId,
      eventType: 'share.created',
      actorId: 'u2',
      occurredAt: '2026-04-02T10:00:00.000Z',
    });
    await recordAuditEvent(adapter, {
      tenantId,
      eventType: 'signing.key.rotated',
      actorId: 'u3',
      occurredAt: '2026-04-03T10:00:00.000Z',
    });
    await recordAuditEvent(adapter, {
      tenantId: otherTenant,
      eventType: 'branding.updated',
      actorId: 'u9',
      occurredAt: '2026-04-04T10:00:00.000Z',
    });

    const app = makeApp({ adapter, tenantCtx: hostCtx(tenantId) });
    const res = await request(app, `/v1/tenants/${tenantId}/audit-events`);

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(tenantId);
    expect(res.body.retentionDays).toBe(AUDIT_RETENTION_DAYS);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.events[0].action).toBe('signing.key.rotated');
    expect(res.body.events[1].action).toBe('share.created');
    expect(res.body.events[2].action).toBe('branding.updated');
    expect(res.body.events.every((e: any) => e.actor)).toBe(true);
    expect(res.body.nextPageToken).toBeNull();
  });

  it('paginates with opaque pageToken (stable across calls)', async () => {
    const adapter = makeAdapter();
    // Use timestamps close to "now" so they fall inside the retention window.
    const baseMs = Date.now() - 60 * 1000;
    for (let i = 0; i < 7; i++) {
      await recordAuditEvent(adapter, {
        tenantId,
        eventType: `evt.${i}`,
        actorId: `u${i}`,
        occurredAt: new Date(baseMs + i * 1000).toISOString(),
      });
    }

    const app = makeApp({ adapter, tenantCtx: hostCtx(tenantId) });
    const p1 = await request(
      app,
      `/v1/tenants/${tenantId}/audit-events?pageSize=3`
    );
    expect(p1.status).toBe(200);
    expect(p1.body.events).toHaveLength(3);
    expect(p1.body.nextPageToken).not.toBeNull();
    // Newest first
    expect(p1.body.events[0].action).toBe('evt.6');
    expect(p1.body.events[2].action).toBe('evt.4');

    const p2 = await request(
      app,
      `/v1/tenants/${tenantId}/audit-events?pageSize=3&pageToken=${encodeURIComponent(
        p1.body.nextPageToken
      )}`
    );
    expect(p2.status).toBe(200);
    expect(p2.body.events).toHaveLength(3);
    expect(p2.body.events[0].action).toBe('evt.3');
    expect(p2.body.events[2].action).toBe('evt.1');
    expect(p2.body.nextPageToken).not.toBeNull();

    const p3 = await request(
      app,
      `/v1/tenants/${tenantId}/audit-events?pageSize=3&pageToken=${encodeURIComponent(
        p2.body.nextPageToken
      )}`
    );
    expect(p3.status).toBe(200);
    expect(p3.body.events).toHaveLength(1);
    expect(p3.body.events[0].action).toBe('evt.0');
    expect(p3.body.nextPageToken).toBeNull();
  });

  it('filters by action, actorId, and resourceType', async () => {
    const adapter = makeAdapter();
    const base = Date.now() - 60 * 1000;
    await recordAuditEvent(adapter, {
      tenantId,
      eventType: 'share.created',
      actorId: 'alice',
      resourceType: 'share-link',
      occurredAt: new Date(base).toISOString(),
    });
    await recordAuditEvent(adapter, {
      tenantId,
      eventType: 'share.created',
      actorId: 'bob',
      resourceType: 'share-link',
      occurredAt: new Date(base + 1000).toISOString(),
    });
    await recordAuditEvent(adapter, {
      tenantId,
      eventType: 'branding.updated',
      actorId: 'alice',
      resourceType: 'branding',
      occurredAt: new Date(base + 2000).toISOString(),
    });

    const app = makeApp({ adapter, tenantCtx: hostCtx(tenantId) });

    const byAction = await request(
      app,
      `/v1/tenants/${tenantId}/audit-events?action=share.created`
    );
    expect(byAction.status).toBe(200);
    expect(byAction.body.events).toHaveLength(2);
    expect(
      new Set(byAction.body.events.map((e: any) => e.action))
    ).toEqual(new Set(['share.created']));

    const byActor = await request(
      app,
      `/v1/tenants/${tenantId}/audit-events?actorId=alice`
    );
    expect(byActor.status).toBe(200);
    expect(byActor.body.events).toHaveLength(2);
    expect(byActor.body.events.every((e: any) => e.actor === 'alice')).toBe(
      true
    );

    const byResource = await request(
      app,
      `/v1/tenants/${tenantId}/audit-events?resourceType=branding`
    );
    expect(byResource.status).toBe(200);
    expect(byResource.body.events).toHaveLength(1);
    expect(byResource.body.events[0].resourceType).toBe('branding');
  });

  it('respects since/until bounds', async () => {
    const adapter = makeAdapter();
    const baseMs = Date.now() - 60 * 1000;
    for (let i = 0; i < 5; i++) {
      await recordAuditEvent(adapter, {
        tenantId,
        eventType: `e.${i}`,
        actorId: 'u',
        occurredAt: new Date(baseMs + i * 1000).toISOString(),
      });
    }
    const app = makeApp({ adapter, tenantCtx: hostCtx(tenantId) });

    const since = new Date(baseMs + 2 * 1000).toISOString();
    const until = new Date(baseMs + 3 * 1000).toISOString();
    const res = await request(
      app,
      `/v1/tenants/${tenantId}/audit-events?since=${encodeURIComponent(
        since
      )}&until=${encodeURIComponent(until)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events.map((e: any) => e.action).sort()).toEqual([
      'e.2',
      'e.3',
    ]);
  });

  it('excludes records older than the retention window', async () => {
    const adapter = makeAdapter();
    // 100 days old — outside the 90-day cap.
    const oldMs = Date.now() - 100 * 24 * 60 * 60 * 1000;
    await recordAuditEvent(adapter, {
      tenantId,
      eventType: 'old.event',
      actorId: 'u',
      occurredAt: new Date(oldMs).toISOString(),
    });
    await recordAuditEvent(adapter, {
      tenantId,
      eventType: 'new.event',
      actorId: 'u',
      occurredAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });

    const app = makeApp({ adapter, tenantCtx: hostCtx(tenantId) });
    const res = await request(app, `/v1/tenants/${tenantId}/audit-events`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].action).toBe('new.event');
  });

  it('400s on invalid pageSize and invalid timestamps', async () => {
    const adapter = makeAdapter();
    const app = makeApp({ adapter, tenantCtx: hostCtx(tenantId) });

    const bad1 = await request(
      app,
      `/v1/tenants/${tenantId}/audit-events?pageSize=0`
    );
    expect(bad1.status).toBe(400);
    expect(bad1.body.error.code).toBe('VALIDATION_ERROR');

    const bad2 = await request(
      app,
      `/v1/tenants/${tenantId}/audit-events?pageSize=999`
    );
    expect(bad2.status).toBe(400);

    const bad3 = await request(
      app,
      `/v1/tenants/${tenantId}/audit-events?since=not-a-date`
    );
    expect(bad3.status).toBe(400);

    const bad4 = await request(
      app,
      `/v1/tenants/${tenantId}/audit-events?since=2026-04-02T00:00:00Z&until=2026-04-01T00:00:00Z`
    );
    expect(bad4.status).toBe(400);
  });

  it('emits audit.queried metering event', async () => {
    const adapter = makeAdapter();
    await recordAuditEvent(adapter, {
      tenantId,
      eventType: 'evt.1',
      actorId: 'u',
      occurredAt: new Date().toISOString(),
    });

    const delivered: NormalizedMeteringEvent[] = [];
    const sink = {
      async deliver(batch: NormalizedMeteringEvent[]) {
        delivered.push(...batch);
      },
    };
    const meteringBus = new MeteringBus({ sink, maxBatchSize: 1 });
    const usageBus = new InMemoryUsageMeteringBus();
    const usageEvents: any[] = [];
    usageBus.subscribe((e) => {
      usageEvents.push(e);
    });

    const app = makeApp({
      adapter,
      tenantCtx: hostCtx(tenantId),
      meteringBus,
      usageBus,
    });

    const res = await request(
      app,
      `/v1/tenants/${tenantId}/audit-events?pageSize=10&actorId=u`
    );
    expect(res.status).toBe(200);

    // MeteringBus flushes on batch-size; give it a tick to drain.
    await new Promise((r) => setTimeout(r, 20));
    await meteringBus.flush();

    expect(delivered.length).toBeGreaterThanOrEqual(1);
    const ev = delivered.find((e) => e.type === 'audit.queried');
    expect(ev).toBeTruthy();
    expect(ev?.tenantId).toBe(tenantId);
    expect((ev?.meta as any)?.pageSize).toBe(10);
    expect((ev?.meta as any)?.filterKeys).toContain('actorId');

    // api.call rollup increments
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].counter).toBe('apiCalls');
    expect(usageEvents[0].tenantId).toBe(tenantId);
  });
});

describe('audit events: collection name + data shape', () => {
  it('writes to the canonical collection with tenantId + occurredAt', async () => {
    const adapter = makeAdapter();
    const rec = await recordAuditEvent(adapter, {
      tenantId,
      eventType: 'share.created',
      actorId: 'u1',
      resourceType: 'share-link',
      targetId: 'sl-123',
    });
    expect(rec.tenantId).toBe(tenantId);
    expect(rec.occurredAt).toBe(rec.createdAt);
    expect(typeof rec.createdAt).toBe('string');
    const stored = await adapter.fetchData<AuditEventRecord>(
      AUDIT_EVENTS_COLLECTION,
      rec.id
    );
    expect(stored).toBeTruthy();
    expect(stored!.eventType).toBe('share.created');
    expect(stored!.resourceType).toBe('share-link');
    expect(stored!.targetId).toBe('sl-123');
  });
});
