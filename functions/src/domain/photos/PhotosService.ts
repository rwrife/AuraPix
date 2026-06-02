/**
 * PhotosService — soft-delete (Trash) lifecycle for photos.
 *
 * Implements the Trash feature from issue #152:
 *   - softDelete: sets `trashedAt` / `trashedBy`; bytes are kept.
 *   - restore:   clears `trashedAt` / `trashedBy`.
 *   - list:      lists active or trashed photos for a tenant.
 *   - purgeExpired: hard-deletes photos whose `trashedAt` exceeds the
 *     retention window. Reuses the existing storage adapter for cleanup.
 *
 * Tenant scoping is enforced via `assertSameTenant` so cross-tenant
 * restores/deletes return 403.
 *
 * Metering: emits `photo.trashed` on soft-delete and `photo.purged` when
 * bytes are actually freed (purge job). Per the metering contract, the
 * `storageBytesDelta` rollup decrements on `photo.purged`, not on
 * `photo.trashed`, so a separate UsageMeteringBus publish is performed in
 * the purge job.
 */

import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { StorageAdapter } from '../../adapters/storage/StorageAdapter.js';
import type { Photo } from '../../models/Photo.js';
import { logger } from '../../utils/logger.js';
import {
  assertSameTenant,
  DEFAULT_TENANT_ID,
  type TenantId,
} from '../tenant/Tenant.js';
import { emitMeteringEvent } from '../../services/metering/index.js';
import type { UsageMeteringBus } from '../../services/metering/UsageMeteringBus.js';

const PHOTOS_COLLECTION = 'photos';

export interface PhotosServiceOptions {
  dataAdapter: DataAdapter;
  storageAdapter?: StorageAdapter;
  /** Optional rollup bus used to decrement `storageBytesDelta` on purge. */
  usageBus?: UsageMeteringBus;
  /** Override clock for tests. */
  now?: () => Date;
}

export class PhotoNotFoundError extends Error {
  public readonly status = 404;
  public readonly code = 'photo-not-found';
  constructor(public readonly photoId: string) {
    super(`Photo ${photoId} not found`);
    this.name = 'PhotoNotFoundError';
  }
}

export class PhotosService {
  private readonly data: DataAdapter;
  private readonly storage: StorageAdapter | undefined;
  private readonly usageBus: UsageMeteringBus | undefined;
  private readonly now: () => Date;

  constructor(opts: PhotosServiceOptions) {
    this.data = opts.dataAdapter;
    this.storage = opts.storageAdapter;
    this.usageBus = opts.usageBus;
    this.now = opts.now ?? (() => new Date());
  }

  /** Fetch a photo, asserting tenant scope. Throws if missing or cross-tenant. */
  async getOwned(photoId: string, callerTenantId: TenantId): Promise<Photo> {
    const photo = await this.data.fetchData<Photo>(PHOTOS_COLLECTION, photoId);
    if (!photo) throw new PhotoNotFoundError(photoId);
    assertSameTenant(photo.tenantId, callerTenantId);
    return photo;
  }

  /**
   * Soft-delete a photo: sets `trashedAt = now`, hides it from default
   * list queries. Bytes are retained until the purge job runs.
   */
  async softDelete(
    photoId: string,
    callerTenantId: TenantId,
    actor: string | null
  ): Promise<Photo> {
    const photo = await this.getOwned(photoId, callerTenantId);

    // Idempotent: re-trashing an already-trashed photo is a no-op.
    if (photo.trashedAt) {
      return photo;
    }

    const trashedAt = this.now().toISOString();
    const updates = {
      trashedAt,
      trashedBy: actor,
      updatedAt: trashedAt,
    };
    await this.data.updateData<Photo>(PHOTOS_COLLECTION, photoId, updates);

    const updated: Photo = { ...photo, ...updates };

    emitMeteringEvent({
      tenantId: photo.tenantId ?? DEFAULT_TENANT_ID,
      type: 'photo.trashed',
      count: 1,
      bytes: photo.metadata?.sizeBytes,
      resourceId: photoId,
      occurredAt: trashedAt,
      meta: {
        libraryId: photo.libraryId,
        actor,
      },
    });

    return updated;
  }

  /**
   * Restore a previously trashed photo. Cross-tenant restore is rejected
   * by {@link assertSameTenant} (surfaces as HTTP 403).
   */
  async restore(photoId: string, callerTenantId: TenantId): Promise<Photo> {
    const photo = await this.getOwned(photoId, callerTenantId);

    if (!photo.trashedAt) {
      return photo;
    }

    const updatedAt = this.now().toISOString();
    const updates = {
      trashedAt: null,
      trashedBy: null,
      updatedAt,
    };
    await this.data.updateData<Photo>(PHOTOS_COLLECTION, photoId, updates);

    return { ...photo, ...updates };
  }

  /**
   * List photos for a tenant. By default returns only active (non-trashed)
   * photos. When `trashed=true`, returns only the tenant's trash.
   */
  async list(
    callerTenantId: TenantId,
    opts: { trashed?: boolean } = {}
  ): Promise<Photo[]> {
    const filterValue = callerTenantId === DEFAULT_TENANT_ID
      ? undefined
      : callerTenantId;

    // queryData supports simple equality filters; we filter tenantId here when
    // it is not the default tenant (legacy docs may have no tenantId field).
    const all = filterValue
      ? await this.data.queryData<Photo>(PHOTOS_COLLECTION, [
          { field: 'tenantId', operator: '==', value: filterValue },
        ])
      : await this.data.queryData<Photo>(PHOTOS_COLLECTION, []);

    // For the default tenant, include legacy docs with missing tenantId.
    const scoped = filterValue
      ? all
      : all.filter(
          (p) => !p.tenantId || p.tenantId === DEFAULT_TENANT_ID
        );

    const wantTrashed = opts.trashed === true;
    return scoped.filter((p) => Boolean(p.trashedAt) === wantTrashed);
  }

  /**
   * Hard-delete trashed photos whose `trashedAt` is older than
   * `retentionDays`. Iterates per-tenant so one noisy tenant cannot
   * starve others. Emits exactly one `photo.purged` event per photo.
   *
   * Returns the list of purged photo ids (per tenant) for observability.
   */
  async purgeExpired(opts: {
    retentionDays: number;
    /** Limit work per tenant per run; default 1000. */
    perTenantLimit?: number;
  }): Promise<{ tenantId: TenantId; photoIds: string[] }[]> {
    const { retentionDays } = opts;
    if (!Number.isFinite(retentionDays) || retentionDays < 0) {
      throw new Error('retentionDays must be a non-negative finite number');
    }
    const perTenantLimit = opts.perTenantLimit ?? 1000;
    const cutoff = new Date(this.now().getTime() - retentionDays * 24 * 60 * 60 * 1000);

    // Pull every trashed photo once, then bucket by tenant so we can iterate
    // tenant-by-tenant. This keeps the operation fair across tenants while
    // remaining usable on top of the existing queryData filter surface.
    const all = await this.data.queryData<Photo>(PHOTOS_COLLECTION, []);
    const byTenant = new Map<TenantId, Photo[]>();
    for (const photo of all) {
      if (!photo.trashedAt) continue;
      const trashedAt = new Date(photo.trashedAt);
      if (Number.isNaN(trashedAt.getTime())) continue;
      if (trashedAt >= cutoff) continue;
      const tenantId = (photo.tenantId ?? DEFAULT_TENANT_ID) as TenantId;
      const bucket = byTenant.get(tenantId) ?? [];
      bucket.push(photo);
      byTenant.set(tenantId, bucket);
    }

    const results: { tenantId: TenantId; photoIds: string[] }[] = [];
    for (const [tenantId, bucket] of byTenant) {
      const purged: string[] = [];
      // Process up to perTenantLimit; oldest-trashedAt first so retention
      // pressure releases evenly.
      bucket.sort((a, b) =>
        String(a.trashedAt).localeCompare(String(b.trashedAt))
      );
      const slice = bucket.slice(0, perTenantLimit);

      for (const photo of slice) {
        try {
          await this.hardDelete(photo);
          purged.push(photo.id);
        } catch (err) {
          // Don't let one bad photo block the rest of the tenant's purge.
          logger.error(
            { err, photoId: photo.id, tenantId },
            'purgeTrash: failed to hard-delete photo'
          );
        }
      }
      results.push({ tenantId, photoIds: purged });
    }

    return results;
  }

  /**
   * Hard-delete a single (already trashed) photo: removes storage bytes,
   * removes the doc, and emits `photo.purged` exactly once.
   */
  private async hardDelete(photo: Photo): Promise<void> {
    const bytes = photo.metadata?.sizeBytes ?? 0;
    const tenantId = (photo.tenantId ?? DEFAULT_TENANT_ID) as TenantId;

    // Storage cleanup: best-effort. The storage adapter's deleteFile is
    // idempotent (ignores missing files in the Firebase adapter).
    if (this.storage) {
      const paths = collectStoragePaths(photo);
      for (const p of paths) {
        try {
          await this.storage.deleteFile(p);
        } catch (err) {
          logger.warn(
            { err, photoId: photo.id, path: p },
            'purgeTrash: storage cleanup failed for path; continuing'
          );
        }
      }
    }

    await this.data.deleteData(PHOTOS_COLLECTION, photo.id);

    // photo.purged on the host webhook bus (host-visible event).
    emitMeteringEvent({
      tenantId,
      type: 'photo.purged',
      count: 1,
      // Negative bytes signals reclaimed storage to hosts that care.
      bytes: -bytes,
      resourceId: photo.id,
      occurredAt: this.now().toISOString(),
      meta: {
        libraryId: photo.libraryId,
        trashedAt: photo.trashedAt ?? null,
      },
    });

    // storageBytesDelta rollup decrements here (not on trash).
    if (this.usageBus && bytes > 0) {
      await this.usageBus.publish({
        tenantId,
        counter: 'storageBytesDelta',
        value: -bytes,
        occurredAt: this.now().toISOString(),
        eventId: `photo.purged:${photo.id}`,
        meta: { libraryId: photo.libraryId },
      });
    }
  }
}

/** Internal helper exported for tests. */
export function collectStoragePaths(photo: Photo): string[] {
  const paths = new Set<string>();
  if (photo.storagePath) paths.add(photo.storagePath);
  if (photo.storagePaths) {
    paths.add(photo.storagePaths.original);
    const d = photo.storagePaths.derivatives;
    if (d) {
      for (const v of Object.values(d)) {
        if (v) paths.add(v);
      }
    }
  }
  return Array.from(paths);
}
