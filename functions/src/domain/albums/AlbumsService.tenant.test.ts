import { describe, expect, it } from 'vitest';
import { InMemoryAlbumRepository } from '../../adapters/domain/in-memory/InMemoryAlbumRepository.js';
import { AlbumsService } from './AlbumsService.js';
import { DEFAULT_TENANT_ID } from '../tenant/Tenant.js';

describe('AlbumsService tenant scoping', () => {
  it('stamps tenantId on create (defaulting to DEFAULT_TENANT_ID)', async () => {
    const service = new AlbumsService(new InMemoryAlbumRepository());

    const a = await service.create({ ownerId: 'u1', title: 'Default' });
    const b = await service.create({ ownerId: 'u1', tenantId: 'acme', title: 'Acme' });

    expect(a.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(b.tenantId).toBe('acme');
  });

  it('lists only albums for the caller tenant', async () => {
    const service = new AlbumsService(new InMemoryAlbumRepository());

    await service.create({ ownerId: 'u1', title: 'Default album' });
    await service.create({ ownerId: 'u1', tenantId: 'acme', title: 'Acme album' });

    const defaultRows = await service.list('u1', DEFAULT_TENANT_ID);
    const acmeRows = await service.list('u1', 'acme');

    expect(defaultRows.map((r) => r.title)).toEqual(['Default album']);
    expect(acmeRows.map((r) => r.title)).toEqual(['Acme album']);
  });

  it('denies cross-tenant remove as not-found (does not leak existence)', async () => {
    const service = new AlbumsService(new InMemoryAlbumRepository());
    const created = await service.create({ ownerId: 'u1', tenantId: 'acme', title: 'Acme' });

    await expect(service.remove('u1', created.id, 'globex')).rejects.toThrow('album-not-found');

    // Original still exists for the right tenant.
    const stillThere = await service.list('u1', 'acme');
    expect(stillThere).toHaveLength(1);
  });

  it('default tenant fallback keeps legacy callers working', async () => {
    const service = new AlbumsService(new InMemoryAlbumRepository());
    const created = await service.create({ ownerId: 'u1', title: 'Legacy' });

    // No explicit tenant on rename/remove \u2192 defaults to DEFAULT_TENANT_ID.
    const renamed = await service.rename('u1', created.id, 'Renamed');
    expect(renamed.title).toBe('Renamed');
    expect(renamed.tenantId).toBe(DEFAULT_TENANT_ID);

    await service.remove('u1', created.id);
    await expect(service.list('u1')).resolves.toEqual([]);
  });
});
