import { randomUUID } from 'node:crypto';
import type { AlbumRepository } from './AlbumRepository.js';
import {
  DEFAULT_TENANT_ID,
  type Album,
  type CreateAlbumInput,
  type TenantId,
} from './types.js';
import { assertSameTenant } from '../tenant/Tenant.js';

export class AlbumsService {
  constructor(private readonly albums: AlbumRepository) {}

  async list(ownerId: string, tenantId: TenantId = DEFAULT_TENANT_ID): Promise<Album[]> {
    const rows = await this.albums.listByOwner(ownerId);
    // Belt-and-suspenders: filter cross-tenant rows even if the repo did not.
    return rows.filter((a) => (a.tenantId ?? DEFAULT_TENANT_ID) === tenantId);
  }

  async create(input: CreateAlbumInput): Promise<Album> {
    const title = input.title.trim();
    if (!title) {
      throw new Error('album-title-required');
    }

    return this.albums.create({
      ...input,
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
      title,
    });
  }

  async rename(
    ownerId: string,
    albumId: string,
    title: string,
    tenantId: TenantId = DEFAULT_TENANT_ID
  ): Promise<Album> {
    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error('album-title-required');
    }

    const updated = await this.albums.updateTitle(ownerId, albumId, nextTitle);
    if (!updated) {
      throw new Error('album-not-found');
    }

    // Enforce tenant isolation at the service layer (server-side, never trust client).
    assertSameTenant(updated.tenantId, tenantId);

    return updated;
  }

  async remove(
    ownerId: string,
    albumId: string,
    tenantId: TenantId = DEFAULT_TENANT_ID
  ): Promise<void> {
    // Look up before delete so we can enforce tenant scoping; treat missing as
    // not-found so we don't leak existence of other-tenant rows.
    const existing = (await this.albums.listByOwner(ownerId)).find((a) => a.id === albumId);
    if (!existing) {
      throw new Error('album-not-found');
    }
    if ((existing.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) {
      throw new Error('album-not-found');
    }

    const deleted = await this.albums.delete(ownerId, albumId);
    if (!deleted) {
      throw new Error('album-not-found');
    }
  }

  static createAlbumRecord(input: CreateAlbumInput): Album {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      ownerId: input.ownerId,
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
      title: input.title,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    };
  }
}
