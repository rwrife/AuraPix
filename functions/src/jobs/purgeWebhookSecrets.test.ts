/**
 * Unit tests for the scheduled webhook-secret purge job (issue #161).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalJsonData } from '../adapters/data/LocalJsonData.js';
import { rotateTenantWebhookSecret } from '../services/host/tenantWebhookSecretService.js';
import { runPurgeWebhookSecretsJob } from './purgeWebhookSecrets.js';
import {
  TENANT_WEBHOOK_SECRETS_COLLECTION,
  type TenantWebhookSecretRecord,
} from '../models/TenantWebhookSecret.js';

function freshAdapter(): LocalJsonData {
  return new LocalJsonData(mkdtempSync(join(tmpdir(), 'purge-job-test-')));
}

describe('runPurgeWebhookSecretsJob', () => {
  it('drops previous material whose grace window has elapsed', async () => {
    const adapter = freshAdapter();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-02T00:00:00.000Z');

    await rotateTenantWebhookSecret(adapter, 'tenant-A', { now: () => t0 });
    await rotateTenantWebhookSecret(adapter, 'tenant-A', {
      now: () => t1,
      graceSeconds: 60,
    });
    await rotateTenantWebhookSecret(adapter, 'tenant-B', { now: () => t0 });
    await rotateTenantWebhookSecret(adapter, 'tenant-B', {
      now: () => t1,
      graceSeconds: 24 * 60 * 60, // still active
    });

    const observe = new Date(t1.getTime() + 10 * 60 * 1000);
    const result = await runPurgeWebhookSecretsJob({
      dataAdapter: adapter,
      now: () => observe,
    });

    expect(result.totalPurged).toBe(1);
    expect(result.tenantIds).toEqual(['tenant-A']);

    const a = await adapter.fetchData<TenantWebhookSecretRecord>(
      TENANT_WEBHOOK_SECRETS_COLLECTION,
      'tenant-A'
    );
    expect(a!.previous).toBeUndefined();
    const b = await adapter.fetchData<TenantWebhookSecretRecord>(
      TENANT_WEBHOOK_SECRETS_COLLECTION,
      'tenant-B'
    );
    expect(b!.previous).toBeDefined();
  });

  it('is a no-op when nothing has expired yet', async () => {
    const adapter = freshAdapter();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const t1 = new Date('2026-01-02T00:00:00.000Z');

    await rotateTenantWebhookSecret(adapter, 'tenant-A', { now: () => t0 });
    await rotateTenantWebhookSecret(adapter, 'tenant-A', { now: () => t1 });

    const observe = new Date(t1.getTime() + 60 * 1000);
    const result = await runPurgeWebhookSecretsJob({
      dataAdapter: adapter,
      now: () => observe,
    });
    expect(result.totalPurged).toBe(0);
    expect(result.tenantIds).toEqual([]);
  });
});
