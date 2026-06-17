import { SmartAlbumsService } from '../../../domain/smartAlbums/SmartAlbumsService.js';
import type { SmartAlbumRepository } from '../../../domain/smartAlbums/SmartAlbumRepository.js';
import type {
  CreateSmartAlbumInput,
  SmartAlbum,
  UpdateSmartAlbumInput,
} from '../../../domain/smartAlbums/types.js';
import { DEFAULT_TENANT_ID, type TenantId } from '../../../domain/tenant/Tenant.js';

/**
 * In-memory implementation of {@link SmartAlbumRepository} suitable for
 * local mode and unit tests. Tenant scoping is enforced at lookup so the
 * domain service has belt-and-suspenders.
 */
export class InMemorySmartAlbumRepository implements SmartAlbumRepository {
  private readonly byId = new Map<string, SmartAlbum>();

  async listByLibrary(tenantId: TenantId, libraryId: string): Promise<SmartAlbum[]> {
    const out: SmartAlbum[] = [];
    for (const album of this.byId.values()) {
      const ownerTenant = (album.tenantId ?? DEFAULT_TENANT_ID) as TenantId;
      if (ownerTenant !== tenantId) continue;
      if (album.libraryId !== libraryId) continue;
      out.push(album);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getById(id: string): Promise<SmartAlbum | null> {
    return this.byId.get(id) ?? null;
  }

  async create(input: CreateSmartAlbumInput): Promise<SmartAlbum> {
    const record = SmartAlbumsService.createSmartAlbumRecord(input);
    this.byId.set(record.id, record);
    return record;
  }

  async update(id: string, updates: UpdateSmartAlbumInput): Promise<SmartAlbum | null> {
    const existing = this.byId.get(id);
    if (!existing) return null;
    const updated: SmartAlbum = {
      ...existing,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.filter !== undefined ? { filter: updates.filter } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.byId.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }

  async countByLibrary(tenantId: TenantId, libraryId: string): Promise<number> {
    let n = 0;
    for (const album of this.byId.values()) {
      const ownerTenant = (album.tenantId ?? DEFAULT_TENANT_ID) as TenantId;
      if (ownerTenant === tenantId && album.libraryId === libraryId) n++;
    }
    return n;
  }
}
