/**
 * SmartAlbumsService — CRUD + materialization for Smart Albums (issue #165).
 *
 * A Smart Album is a saved filter DSL scoped to (tenantId, libraryId). It
 * has no membership table; `materialize` re-runs the filter against the
 * `photos` collection at read time.
 *
 * Tenant scoping is enforced at every read and write via
 * {@link assertSameTenant}. The filter validator hard-rejects unknown keys
 * to prevent query injection across tenants.
 */
import { randomUUID } from 'node:crypto';
import type { Photo } from '../../models/Photo.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { SmartAlbumRepository } from './SmartAlbumRepository.js';
import {
  parseSmartAlbumFilter,
  parseSmartAlbumName,
  SmartAlbumValidationError,
} from './filterDsl.js';
import {
  SMART_ALBUMS_PER_LIBRARY_CAP,
  type CreateSmartAlbumInput,
  type SmartAlbum,
  type SmartAlbumFilter,
  type UpdateSmartAlbumInput,
} from './types.js';
import {
  assertSameTenant,
  DEFAULT_TENANT_ID,
  type TenantId,
} from '../tenant/Tenant.js';
import { emitMeteringEvent } from '../../services/metering/index.js';

const PHOTOS_COLLECTION = 'photos';

export class SmartAlbumNotFoundError extends Error {
  public readonly status = 404;
  public readonly code = 'smart-album-not-found';
  constructor(public readonly smartAlbumId: string) {
    super(`Smart album ${smartAlbumId} not found`);
    this.name = 'SmartAlbumNotFoundError';
  }
}

export class SmartAlbumsCapExceededError extends Error {
  public readonly status = 409;
  public readonly code = 'smart-album-cap-exceeded';
  constructor(public readonly cap: number, public readonly libraryId: string) {
    super(
      `Smart album cap of ${cap} reached for library ${libraryId}; delete one before creating another.`
    );
    this.name = 'SmartAlbumsCapExceededError';
  }
}

export interface MaterializeOptions {
  pageSize?: number;
  /** Opaque token returned in the previous response. */
  pageToken?: string | null;
}

export interface MaterializeResult {
  photos: Photo[];
  nextPageToken: string | null;
  total: number;
}

export interface SmartAlbumsServiceOptions {
  repo: SmartAlbumRepository;
  dataAdapter: DataAdapter;
  cap?: number;
  now?: () => Date;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class SmartAlbumsService {
  private readonly repo: SmartAlbumRepository;
  private readonly data: DataAdapter;
  private readonly cap: number;
  private readonly now: () => Date;

  constructor(opts: SmartAlbumsServiceOptions) {
    this.repo = opts.repo;
    this.data = opts.dataAdapter;
    this.cap = opts.cap ?? SMART_ALBUMS_PER_LIBRARY_CAP;
    this.now = opts.now ?? (() => new Date());
  }

  /** Build a fresh document, used by repositories during persistence. */
  static createSmartAlbumRecord(input: CreateSmartAlbumInput): SmartAlbum {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
      libraryId: input.libraryId,
      ownerId: input.ownerId,
      name: input.name,
      filter: input.filter,
      createdAt: now,
      updatedAt: now,
    };
  }

  async list(tenantId: TenantId, libraryId: string): Promise<SmartAlbum[]> {
    const rows = await this.repo.listByLibrary(tenantId, libraryId);
    // Belt-and-suspenders: filter cross-tenant rows even if the repo did not.
    return rows.filter(
      (a) => (a.tenantId ?? DEFAULT_TENANT_ID) === tenantId
    );
  }

  async get(id: string, callerTenantId: TenantId): Promise<SmartAlbum> {
    const album = await this.repo.getById(id);
    if (!album) {
      throw new SmartAlbumNotFoundError(id);
    }
    assertSameTenant(album.tenantId, callerTenantId);
    return album;
  }

  async create(input: {
    libraryId: string;
    ownerId: string;
    tenantId: TenantId;
    name: unknown;
    filter: unknown;
  }): Promise<SmartAlbum> {
    const name = parseSmartAlbumName(input.name);
    const filter = parseSmartAlbumFilter(input.filter);

    const count = await this.repo.countByLibrary(input.tenantId, input.libraryId);
    if (count >= this.cap) {
      throw new SmartAlbumsCapExceededError(this.cap, input.libraryId);
    }

    const created = await this.repo.create({
      libraryId: input.libraryId,
      ownerId: input.ownerId,
      tenantId: input.tenantId,
      name,
      filter,
    });

    emitMeteringEvent({
      tenantId: created.tenantId ?? DEFAULT_TENANT_ID,
      type: 'smart_album.created',
      count: 1,
      resourceId: created.id,
      occurredAt: created.createdAt,
      meta: { libraryId: created.libraryId },
    });

    return created;
  }

  async update(
    id: string,
    callerTenantId: TenantId,
    updates: { name?: unknown; filter?: unknown }
  ): Promise<SmartAlbum> {
    const existing = await this.get(id, callerTenantId);
    const next: UpdateSmartAlbumInput = {};
    if (updates.name !== undefined) {
      next.name = parseSmartAlbumName(updates.name);
    }
    if (updates.filter !== undefined) {
      next.filter = parseSmartAlbumFilter(updates.filter);
    }
    if (next.name === undefined && next.filter === undefined) {
      // Nothing changed; return existing as-is.
      return existing;
    }
    const updated = await this.repo.update(id, next);
    if (!updated) {
      throw new SmartAlbumNotFoundError(id);
    }
    return updated;
  }

  async remove(id: string, callerTenantId: TenantId): Promise<void> {
    const existing = await this.get(id, callerTenantId);
    const deleted = await this.repo.delete(id);
    if (!deleted) {
      throw new SmartAlbumNotFoundError(id);
    }
    emitMeteringEvent({
      tenantId: existing.tenantId ?? DEFAULT_TENANT_ID,
      type: 'smart_album.deleted',
      count: 1,
      resourceId: id,
      occurredAt: this.now().toISOString(),
      meta: { libraryId: existing.libraryId },
    });
  }

  /**
   * Materialize a smart album: re-run the saved filter against the photos
   * collection. Tenant + library scoping is applied first (indexed
   * equality filters), then the in-memory filter narrows the result set.
   *
   * Pagination is offset-based: `pageToken` encodes the next start index.
   */
  async materialize(
    id: string,
    callerTenantId: TenantId,
    opts: MaterializeOptions = {}
  ): Promise<MaterializeResult> {
    const album = await this.get(id, callerTenantId);

    // Re-validate stored filter so a corrupted document cannot crash a read.
    const filter = parseSmartAlbumFilter(album.filter);

    const pageSize = clampPageSize(opts.pageSize);
    const start = decodePageToken(opts.pageToken);

    // 1) Indexed scope: photos in this tenant + library.
    const equality = [
      { field: 'tenantId', operator: '==' as const, value: album.tenantId },
      { field: 'libraryId', operator: '==' as const, value: album.libraryId },
    ];
    const all = await this.data.queryData<Photo>(PHOTOS_COLLECTION, equality);

    // 2) In-memory narrow: apply DSL clauses + hide trashed.
    const matched = all
      .filter((p) => !p.trashedAt)
      .filter((p) => matchesFilter(p, filter))
      // Stable order: most recent updatedAt first, then id for determinism.
      .sort((a, b) => {
        const cmp = String(b.updatedAt).localeCompare(String(a.updatedAt));
        return cmp !== 0 ? cmp : String(a.id).localeCompare(String(b.id));
      });

    const total = matched.length;
    const page = matched.slice(start, start + pageSize);
    const nextStart = start + page.length;
    const nextPageToken = nextStart < total ? encodePageToken(nextStart) : null;

    emitMeteringEvent({
      tenantId: album.tenantId ?? DEFAULT_TENANT_ID,
      type: 'smart_album.materialized',
      count: 1,
      resourceId: album.id,
      occurredAt: this.now().toISOString(),
      meta: {
        libraryId: album.libraryId,
        resultCount: page.length,
        totalCount: total,
      },
    });

    return { photos: page, nextPageToken, total };
  }

  /** Validation helper exported for callers that want a dry-run validate. */
  static validateFilter(input: unknown): SmartAlbumFilter {
    return parseSmartAlbumFilter(input);
  }
}

export { SmartAlbumValidationError };

// ---- helpers --------------------------------------------------------------

function clampPageSize(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(value), MAX_PAGE_SIZE);
}

function encodePageToken(start: number): string {
  return Buffer.from(JSON.stringify({ s: start }), 'utf8').toString('base64url');
}

function decodePageToken(token: string | null | undefined): number {
  if (!token) return 0;
  try {
    const decoded = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8')
    ) as { s?: unknown };
    if (typeof decoded.s === 'number' && decoded.s >= 0 && Number.isInteger(decoded.s)) {
      return decoded.s;
    }
  } catch {
    // fall through
  }
  return 0;
}

function matchesFilter(photo: Photo, filter: SmartAlbumFilter): boolean {
  // rating
  if (filter.rating) {
    const rating = (photo as unknown as { rating?: unknown }).rating;
    if (typeof rating !== 'number') return false;
    if (filter.rating.gte !== undefined && rating < filter.rating.gte) return false;
    if (filter.rating.lte !== undefined && rating > filter.rating.lte) return false;
  }

  // flag
  if (filter.flag) {
    const flag = (photo as unknown as { flag?: unknown }).flag;
    if (flag !== filter.flag) return false;
  }

  // tags (ANY-of)
  if (filter.tags && filter.tags.length > 0) {
    const photoTags = (photo as unknown as { tags?: unknown }).tags;
    if (!Array.isArray(photoTags)) return false;
    const set = new Set(photoTags.filter((t) => typeof t === 'string'));
    const anyMatch = filter.tags.some((t) => set.has(t));
    if (!anyMatch) return false;
  }

  // capturedBetween (inclusive)
  if (filter.capturedBetween) {
    const taken = photo.metadata?.takenAt;
    if (!taken) return false;
    const t = Date.parse(taken);
    if (Number.isNaN(t)) return false;
    const from = Date.parse(filter.capturedBetween[0]);
    const to = Date.parse(filter.capturedBetween[1]);
    if (t < from || t > to) return false;
  }

  // mimeTypes (ANY-of)
  if (filter.mimeTypes && filter.mimeTypes.length > 0) {
    const mt = photo.metadata?.mimeType;
    if (typeof mt !== 'string') return false;
    if (!filter.mimeTypes.includes(mt)) return false;
  }

  return true;
}
