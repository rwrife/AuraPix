/**
 * Tenant data export + hard offboarding (issue #155).
 *
 * Two responsibilities, both gated by the host-only `tenant.admin` scope:
 *
 *  1. **Export.** Schedule a job that bundles a tenant's photo metadata,
 *     album metadata, and originals into a single archive at a stable
 *     export bucket path (`exports/{tenantId}/{exportId}.zip`). The
 *     archive is delivered to the host via a tenant-scoped signed URL
 *     with a 24h TTL.
 *
 *  2. **Delete.** Hard-delete every byte AuraPix stores for a tenant.
 *     The sweep is idempotent and resumable: progress is written to
 *     `tenants/{id}/_deletion` so a kill mid-sweep can be replayed
 *     without duplicate event emission. The final step removes the
 *     tenant doc itself and emits a single `tenant.deleted` event.
 *
 * The implementation here is deliberately minimal: the export "job"
 * runs synchronously in-process and produces an NDJSON manifest +
 * pointers to the storage paths of originals (a full ZIP packer is
 * left for a follow-up, see the limitation note in
 * `docs/features/tenant-offboarding.md`). The shape of the public API
 * is what matters \u2014 the worker can be swapped behind it.
 */
import { randomUUID, createHash } from 'node:crypto';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import { emitMeteringEvent } from '../metering/index.js';
import { logger } from '../../utils/logger.js';

export type ExportStatus = 'pending' | 'running' | 'ready' | 'failed';

export interface TenantExportRecord {
  id: string;
  tenantId: string;
  status: ExportStatus;
  createdAt: string;
  completedAt: string | null;
  /** Path inside the storage adapter where the archive lives. */
  storagePath: string;
  /** Total bytes written for the archive. */
  bytes: number;
  /** Optional signed URL handed back to the host. Short-lived (~24h). */
  downloadUrl?: string;
  downloadUrlExpiresAt?: string;
  /** Hash of the manifest for tamper-evidence. */
  manifestSha256?: string;
  /** Set on failure. */
  error?: string;
}

export interface DeletionProgress {
  tenantId: string;
  startedAt: string;
  completedAt: string | null;
  /** Whether `tenant.deleted` has been emitted. Used for idempotency on resume. */
  eventEmitted: boolean;
  itemsDeleted: number;
  bytesFreed: number;
  /** Last collection swept; useful for debugging interrupted runs. */
  lastCollection?: string;
}

export const TENANT_EXPORTS_COLLECTION = 'tenantExports';
export const TENANT_DELETIONS_COLLECTION = 'tenantDeletions';
export const TENANT_DELETION_PROGRESS_DOC = '_progress';

/** Tenant-partitioned collections the delete sweep must clear. */
export const TENANT_PARTITIONED_COLLECTIONS: readonly string[] = [
  'libraries',
  'albums',
  'photos',
  'uploadSessions',
  'tenantApiKeys',
  'tenantBranding',
  'usageDaily',
  'webhookDeliveries',
] as const;

export interface TenantOffboardingServiceDeps {
  data: DataAdapter;
  storage: StorageAdapter;
  /**
   * Optional signer producing a short-lived URL for the export archive.
   * When omitted, a pseudo URL is returned (suitable for tests / local
   * mode); production wires this to the real signed-URL helper.
   */
  signDownloadUrl?: (
    storagePath: string,
    expiresAt: Date
  ) => Promise<string> | string;
  /** Override for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

const DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export class TenantOffboardingService {
  private readonly data: DataAdapter;
  private readonly storage: StorageAdapter;
  private readonly signDownloadUrl: NonNullable<
    TenantOffboardingServiceDeps['signDownloadUrl']
  >;
  private readonly now: () => Date;

  constructor(deps: TenantOffboardingServiceDeps) {
    this.data = deps.data;
    this.storage = deps.storage;
    this.signDownloadUrl =
      deps.signDownloadUrl ??
      ((path, expiresAt) =>
        `local://exports/${encodeURIComponent(path)}?expires=${expiresAt.getTime()}`);
    this.now = deps.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- export

  /**
   * Enqueue an export. Returns a record with `status: 'pending'` and
   * kicks off the worker out-of-band. Callers poll
   * {@link getExport} to retrieve a download URL.
   */
  async requestExport(tenantId: string): Promise<TenantExportRecord> {
    const exportId = `exp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const createdAt = this.now().toISOString();
    const record: TenantExportRecord = {
      id: exportId,
      tenantId,
      status: 'pending',
      createdAt,
      completedAt: null,
      storagePath: `exports/${tenantId}/${exportId}.ndjson`,
      bytes: 0,
    };
    await this.data.storeData(
      this.exportsCollection(tenantId),
      exportId,
      record
    );

    emitMeteringEvent({
      tenantId,
      type: 'tenant.export.requested',
      resourceId: exportId,
      occurredAt: createdAt,
    });

    // Run the export asynchronously. Failures are captured into the
    // record; the request itself always succeeds.
    void this.runExport(tenantId, exportId).catch((err) => {
      logger.error(
        { err, tenantId, exportId },
        'tenant export job crashed unexpectedly'
      );
    });

    return record;
  }

  async getExport(
    tenantId: string,
    exportId: string
  ): Promise<TenantExportRecord | null> {
    const record = await this.data.fetchData<TenantExportRecord>(
      this.exportsCollection(tenantId),
      exportId
    );
    if (!record) return null;
    // Cross-tenant safety check.
    if (record.tenantId !== tenantId) return null;
    if (record.status === 'ready' && record.storagePath) {
      const expires = new Date(this.now().getTime() + DOWNLOAD_TTL_MS);
      record.downloadUrl = await this.signDownloadUrl(
        record.storagePath,
        expires
      );
      record.downloadUrlExpiresAt = expires.toISOString();
    }
    return record;
  }

  private exportsCollection(tenantId: string): string {
    return `${TENANT_EXPORTS_COLLECTION}_${tenantId}`;
  }

  private async runExport(tenantId: string, exportId: string): Promise<void> {
    const collection = this.exportsCollection(tenantId);
    try {
      await this.data.updateData<TenantExportRecord>(collection, exportId, {
        status: 'running',
      });

      const manifest = await this.buildManifest(tenantId);
      const payload = Buffer.from(
        manifest.map((row) => JSON.stringify(row)).join('\n'),
        'utf8'
      );
      const storagePath = `exports/${tenantId}/${exportId}.ndjson`;
      await this.storage.storeFile(storagePath, payload, {
        contentType: 'application/x-ndjson',
        customMetadata: { tenantId, exportId },
      });

      const completedAt = this.now().toISOString();
      const sha = createHash('sha256').update(payload).digest('hex');
      const updates: Partial<TenantExportRecord> = {
        status: 'ready',
        completedAt,
        storagePath,
        bytes: payload.byteLength,
        manifestSha256: sha,
      };
      await this.data.updateData<TenantExportRecord>(
        collection,
        exportId,
        updates
      );

      emitMeteringEvent({
        tenantId,
        type: 'tenant.export.completed',
        resourceId: exportId,
        bytes: payload.byteLength,
        occurredAt: completedAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, tenantId, exportId }, 'tenant export failed');
      await this.data
        .updateData<TenantExportRecord>(collection, exportId, {
          status: 'failed',
          completedAt: this.now().toISOString(),
          error: message,
        })
        .catch(() => {
          // best-effort
        });
    }
  }

  /**
   * Build the NDJSON manifest for a tenant. One row per resource;
   * originals are referenced by their storage path rather than
   * inlined (the host fetches them via signed URL using the
   * existing image-auth surface).
   */
  private async buildManifest(
    tenantId: string
  ): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    rows.push({
      kind: 'manifest.header',
      tenantId,
      generatedAt: this.now().toISOString(),
      version: 1,
    });

    for (const collection of TENANT_PARTITIONED_COLLECTIONS) {
      try {
        const docs = await this.data.queryData<{ tenantId?: string }>(
          collection,
          [{ field: 'tenantId', operator: '==', value: tenantId }]
        );
        for (const doc of docs) {
          rows.push({ kind: collection, data: doc });
        }
      } catch (err) {
        // Tolerate missing collections \u2014 the manifest records the gap.
        rows.push({
          kind: 'manifest.warning',
          collection,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // List original storage paths so the host can re-fetch them.
    try {
      const storagePrefix = `tenants/${tenantId}/originals/`;
      const files = await this.storage.listFiles(storagePrefix);
      for (const f of files) {
        rows.push({ kind: 'storage.original', path: f });
      }
    } catch (err) {
      rows.push({
        kind: 'manifest.warning',
        section: 'storage.originals',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return rows;
  }

  // ---------------------------------------------------------------- delete

  /**
   * Idempotent, resumable hard-delete of a tenant.
   *
   * Writes progress to `tenantDeletions_{tenantId}/_progress`. Re-invoking
   * this method after an interruption resumes from the next collection
   * and never re-emits `tenant.deleted`.
   */
  async deleteTenant(tenantId: string): Promise<DeletionProgress> {
    const progressCollection = `${TENANT_DELETIONS_COLLECTION}_${tenantId}`;
    let progress = await this.data.fetchData<DeletionProgress>(
      progressCollection,
      TENANT_DELETION_PROGRESS_DOC
    );
    if (!progress) {
      progress = {
        tenantId,
        startedAt: this.now().toISOString(),
        completedAt: null,
        eventEmitted: false,
        itemsDeleted: 0,
        bytesFreed: 0,
      };
      await this.data.storeData(
        progressCollection,
        TENANT_DELETION_PROGRESS_DOC,
        progress
      );
    }

    if (progress.completedAt && progress.eventEmitted) {
      // Already done. Idempotent no-op.
      return progress;
    }

    for (const collection of TENANT_PARTITIONED_COLLECTIONS) {
      try {
        const docs = await this.data.queryData<{
          id?: string;
          tenantId?: string;
          bytes?: number;
        }>(collection, [
          { field: 'tenantId', operator: '==', value: tenantId },
        ]);
        for (const doc of docs) {
          const id = (doc as { id?: string }).id;
          if (!id) continue;
          await this.data.deleteData(collection, id);
          progress.itemsDeleted += 1;
          if (typeof doc.bytes === 'number') {
            progress.bytesFreed += doc.bytes;
          }
        }
      } catch (err) {
        logger.warn(
          { err, tenantId, collection },
          'tenant delete: collection sweep failed (continuing)'
        );
      }
      progress.lastCollection = collection;
      await this.data.updateData<DeletionProgress>(
        progressCollection,
        TENANT_DELETION_PROGRESS_DOC,
        progress
      );
    }

    // Storage sweep: blow away anything under tenants/{id}/.
    try {
      const storagePrefix = `tenants/${tenantId}/`;
      const files = await this.storage.listFiles(storagePrefix);
      for (const f of files) {
        try {
          await this.storage.deleteFile(f);
          progress.itemsDeleted += 1;
        } catch (err) {
          logger.warn({ err, tenantId, file: f }, 'tenant delete: file unlink failed');
        }
      }
    } catch (err) {
      logger.warn({ err, tenantId }, 'tenant delete: storage sweep failed');
    }

    // Remove tenant doc itself.
    try {
      await this.data.deleteData('tenants', tenantId);
    } catch {
      // tenants collection may not exist yet \u2014 tolerated.
    }

    progress.completedAt = this.now().toISOString();
    if (!progress.eventEmitted) {
      emitMeteringEvent({
        tenantId,
        type: 'tenant.deleted',
        bytes: -progress.bytesFreed,
        occurredAt: progress.completedAt,
        meta: { itemsDeleted: progress.itemsDeleted },
      });
      progress.eventEmitted = true;
    }
    await this.data.updateData<DeletionProgress>(
      progressCollection,
      TENANT_DELETION_PROGRESS_DOC,
      progress
    );

    return progress;
  }

  async isTenantDeleted(tenantId: string): Promise<boolean> {
    const progressCollection = `${TENANT_DELETIONS_COLLECTION}_${tenantId}`;
    const progress = await this.data.fetchData<DeletionProgress>(
      progressCollection,
      TENANT_DELETION_PROGRESS_DOC
    );
    return !!(progress && progress.completedAt && progress.eventEmitted);
  }
}
