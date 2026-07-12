/**
 * Signed-URL middleware enforcement of the per-tenant `originalDownload`
 * feature flag (issue #208).
 *
 * The middleware wraps `SignatureValidator` + `ImageAuthorizer`; those
 * are validated in their own suites. Here we mock both to isolate the
 * flag gate: for a photo whose tenant has `originalDownload: false`,
 * requests for the `original` variant must be rejected with 403
 * `feature_disabled` and a `feature.gated` event, while requests for a
 * derivative size (`large`) must pass through unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import type { DataAdapter } from '../adapters/data/DataAdapter.js';
import { errorHandler } from './errorHandler.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../services/metering/MeteringBus.js';
import { setMeteringBus } from '../services/metering/index.js';
import {
  TENANT_FEATURES_CONFIG_COLLECTION,
  type TenantFeaturesConfigRecord,
} from '../models/TenantFeaturesConfig.js';
import { __resetTenantFeaturesCacheForTests } from '../services/host/tenantFeaturesConfigService.js';
import type { ImageSignature } from '../models/ImageAuth.js';

// Mock signature parsing/validation to always succeed for query
// `?sig=<size>` where <size> ∈ {original, large}. This lets us focus on
// the flag-gate behavior without reconstructing a real HMAC.
vi.mock('../services/imageAuth/SignatureValidator.js', () => {
  class FakeSignatureValidator {
    constructor(_secret: string) {}
    parseSignature(param: string): ImageSignature | null {
      if (!param) return null;
      const size = param === 'original' ? 'original' : 'large';
      return {
        libraryId: 'lib-1',
        photoId: 'photo-1',
        size,
        format: 'jpeg',
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        userId: 'u_1',
      };
    }
    validateSignature(): boolean {
      return true;
    }
  }
  return { SignatureValidator: FakeSignatureValidator };
});

// Mock authorizer to always authorize.
vi.mock('../services/imageAuth/ImageAuthorizer.js', () => {
  class FakeImageAuthorizer {
    constructor(_data: DataAdapter) {}
    setViewTracker(_t: unknown): void {}
    async authorizeImageAccess() {
      return { authorized: true };
    }
  }
  return { ImageAuthorizer: FakeImageAuthorizer };
});

// Import AFTER the mocks are registered.
import { createSignedUrlMiddleware } from './signedUrl.js';

class CapturingSink implements MeteringSink {
  events: NormalizedMeteringEvent[] = [];
  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

function makeData(
  tenantId: string,
  featuresDoc: TenantFeaturesConfigRecord | null
): DataAdapter {
  return {
    getPhoto: vi.fn(async () => ({
      id: 'photo-1',
      libraryId: 'lib-1',
      tenantId,
      metadata: { sizeBytes: 100 },
    })),
    fetchData: vi.fn(async <T>(collection: string, _id: string) => {
      if (collection === TENANT_FEATURES_CONFIG_COLLECTION && featuresDoc) {
        return featuresDoc as unknown as T;
      }
      return null;
    }),
  } as unknown as DataAdapter;
}

function makeApp(data: DataAdapter): Express {
  const app = express();
  const mw = createSignedUrlMiddleware(data);
  app.get('/images/:libraryId/:photoId', mw, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

async function get(app: Express, path: string): Promise<{ status: number; body: any }> {
  const { createServer } = await import('node:http');
  const server = createServer(app as unknown as (req: any, res: any) => void);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('signedUrl middleware — originalDownload gating (#208)', () => {
  let sink: CapturingSink;
  let bus: MeteringBus;

  beforeEach(() => {
    process.env.SIGNING_MASTER_SECRET =
      process.env.SIGNING_MASTER_SECRET ?? 'a'.repeat(64);
    __resetTenantFeaturesCacheForTests();
    sink = new CapturingSink();
    bus = new MeteringBus({ sink, flushIntervalMs: 5, maxBatchSize: 1 });
    setMeteringBus(bus);
  });
  afterEach(() => {
    setMeteringBus(null);
    __resetTenantFeaturesCacheForTests();
    vi.restoreAllMocks();
  });

  it('rejects the `original` variant with 403 + feature.gated when originalDownload is disabled', async () => {
    const tenantId = 'tenant-free';
    const featuresDoc: TenantFeaturesConfigRecord = {
      tenantId,
      flags: { originalDownload: false },
      updatedAt: new Date().toISOString(),
      updatedBy: 'test',
    };
    const data = makeData(tenantId, featuresDoc);
    const app = makeApp(data);
    const res = await get(app, '/images/lib-1/photo-1?sig=original');
    expect(res.status).toBe(403);
    // errorHandler wraps AppError; the code we threw is "feature_disabled".
    expect(JSON.stringify(res.body)).toContain('feature_disabled');

    await bus.flush();
    const gated = sink.events.filter((e) => e.type === 'feature.gated');
    expect(gated).toHaveLength(1);
    expect((gated[0]?.meta as any).feature).toBe('originalDownload');
    expect((gated[0]?.meta as any).variant).toBe('original');
  });

  it('allows derivative variants (`large`) when originalDownload is disabled', async () => {
    const tenantId = 'tenant-free';
    const featuresDoc: TenantFeaturesConfigRecord = {
      tenantId,
      flags: { originalDownload: false },
      updatedAt: new Date().toISOString(),
      updatedBy: 'test',
    };
    const data = makeData(tenantId, featuresDoc);
    const app = makeApp(data);
    const res = await get(app, '/images/lib-1/photo-1?sig=large');
    expect(res.status).toBe(200);

    await bus.flush();
    const gated = sink.events.filter((e) => e.type === 'feature.gated');
    expect(gated).toHaveLength(0);
  });

  it('allows the `original` variant when the flag is enabled (default-on, no doc)', async () => {
    const tenantId = 'tenant-pro';
    const data = makeData(tenantId, null);
    const app = makeApp(data);
    const res = await get(app, '/images/lib-1/photo-1?sig=original');
    expect(res.status).toBe(200);

    await bus.flush();
    const gated = sink.events.filter((e) => e.type === 'feature.gated');
    expect(gated).toHaveLength(0);
  });
});
