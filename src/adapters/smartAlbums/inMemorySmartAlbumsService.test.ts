import { describe, it, expect } from 'vitest';
import { InMemorySmartAlbumsService } from './inMemorySmartAlbumsService';

describe('InMemorySmartAlbumsService', () => {
  it('creates and lists smart albums per library', async () => {
    const svc = new InMemorySmartAlbumsService();
    const a = await svc.create({
      libraryId: 'lib-a',
      name: '5-stars',
      filter: { rating: { gte: 5 } },
    });
    await svc.create({
      libraryId: 'lib-b',
      name: 'picks',
      filter: { flag: 'pick' },
    });

    const listA = await svc.listByLibrary('lib-a');
    expect(listA).toHaveLength(1);
    expect(listA[0].id).toBe(a.id);

    const listB = await svc.listByLibrary('lib-b');
    expect(listB).toHaveLength(1);
    expect(listB[0].name).toBe('picks');
  });

  it('rejects unknown filter keys', async () => {
    const svc = new InMemorySmartAlbumsService();
    await expect(
      svc.create({
        libraryId: 'lib-a',
        name: 'x',
        // @ts-expect-error: deliberately invalid
        filter: { evilKey: 'oops' },
      })
    ).rejects.toThrow(/unknown key/);
  });

  it('rejects empty names', async () => {
    const svc = new InMemorySmartAlbumsService();
    await expect(
      svc.create({ libraryId: 'lib-a', name: '   ', filter: {} })
    ).rejects.toThrow(/required/);
  });

  it('rejects rating gte > lte', async () => {
    const svc = new InMemorySmartAlbumsService();
    await expect(
      svc.create({
        libraryId: 'lib-a',
        name: 'x',
        filter: { rating: { gte: 4, lte: 2 } },
      })
    ).rejects.toThrow(/cannot exceed/);
  });

  it('rejects out-of-range rating', async () => {
    const svc = new InMemorySmartAlbumsService();
    await expect(
      svc.create({
        libraryId: 'lib-a',
        name: 'x',
        filter: { rating: { gte: 9 } },
      })
    ).rejects.toThrow(/0..5/);
  });

  it('rejects bad flag values', async () => {
    const svc = new InMemorySmartAlbumsService();
    await expect(
      svc.create({
        libraryId: 'lib-a',
        name: 'x',
        // @ts-expect-error: deliberately invalid
        filter: { flag: 'maybe' },
      })
    ).rejects.toThrow(/pick|reject/);
  });

  it('updates name and filter', async () => {
    const svc = new InMemorySmartAlbumsService();
    const a = await svc.create({
      libraryId: 'lib-a',
      name: 'old',
      filter: {},
    });
    const updated = await svc.update(a.id, {
      name: 'new',
      filter: { tags: ['family'] },
    });
    expect(updated.name).toBe('new');
    expect(updated.filter.tags).toEqual(['family']);
  });

  it('removes a smart album', async () => {
    const svc = new InMemorySmartAlbumsService();
    const a = await svc.create({ libraryId: 'lib-a', name: 'a', filter: {} });
    await svc.remove(a.id);
    expect(await svc.get(a.id)).toBeNull();
  });
});
