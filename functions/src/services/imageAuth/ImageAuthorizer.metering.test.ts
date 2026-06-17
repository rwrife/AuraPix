import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageAuthorizer } from './ImageAuthorizer.js';
import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { Photo } from '../../models/Photo.js';
import {
  MeteringBus,
  type MeteringSink,
  type NormalizedMeteringEvent,
} from '../metering/MeteringBus.js';
import { setMeteringBus } from '../metering/index.js';

class CapturingSink implements MeteringSink {
  events: NormalizedMeteringEvent[] = [];
  async deliver(events: NormalizedMeteringEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

function photoFixture(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 'photo-1',
    libraryId: 'lib-1',
    albumIds: ['album-1'],
    originalName: 'a.jpg',
    metadata: { width: 1, height: 1, mimeType: 'image/jpeg', sizeBytes: 1 },
    status: 'ready',
    currentEditVersion: 0,
    editHistory: [],
    thumbnailsOutdated: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Photo;
}

interface FakeShareLink {
  id: string;
  token: string;
  resourceType: 'album' | 'photo' | 'library';
  resourceId: string;
  revoked: boolean;
  policy: { expiresAt: string | null; maxUses: number | null };
  useCount: number;
}

function makeDataAdapter(shareLinks: FakeShareLink[]): DataAdapter {
  return {
    storeData: vi.fn(async () => {}),
    fetchData: vi.fn(async () => null),
    queryData: vi.fn(async (_coll: string) => shareLinks as unknown as never[]),
    updateData: vi.fn(async () => {}),
    deleteData: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    listIds: vi.fn(async () => []),
    getPhoto: vi.fn(async () => null),
  } as unknown as DataAdapter;
}

describe('ImageAuthorizer share.viewed metering', () => {
  let sink: CapturingSink;
  let bus: MeteringBus;

  beforeEach(() => {
    sink = new CapturingSink();
    bus = new MeteringBus({ sink, flushIntervalMs: 10, maxBatchSize: 1 });
    setMeteringBus(bus);
  });

  afterEach(() => {
    setMeteringBus(null);
    vi.restoreAllMocks();
  });

  it('emits share.viewed on a successful album share access', async () => {
    const photo = photoFixture();
    const link: FakeShareLink = {
      id: 'link-1',
      token: 'tok-abc',
      resourceType: 'album',
      resourceId: 'album-1',
      revoked: false,
      policy: { expiresAt: null, maxUses: null },
      useCount: 0,
    };
    const data = makeDataAdapter([link]);
    const authz = new ImageAuthorizer(data);

    const granted = await authz.checkShareAccess('tok-abc', photo);
    await bus.flush();

    expect(granted).toBe(true);
    const evts = sink.events.filter((e) => e.type === 'share.viewed');
    expect(evts).toHaveLength(1);
    expect(evts[0]!.tenantId).toBe('lib:lib-1');
    expect(evts[0]!.resourceId).toBe('link-1');
    expect(evts[0]!.meta).toMatchObject({
      photoId: 'photo-1',
      libraryId: 'lib-1',
      grantType: 'album',
    });
  });

  it('does NOT emit share.viewed for a revoked share link', async () => {
    const link: FakeShareLink = {
      id: 'link-2',
      token: 'tok-rev',
      resourceType: 'photo',
      resourceId: 'photo-1',
      revoked: true,
      policy: { expiresAt: null, maxUses: null },
      useCount: 0,
    };
    const authz = new ImageAuthorizer(makeDataAdapter([link]));
    const granted = await authz.checkShareAccess('tok-rev', photoFixture());
    await bus.flush();

    expect(granted).toBe(false);
    expect(sink.events.filter((e) => e.type === 'share.viewed')).toHaveLength(0);
  });

  it('does NOT emit share.viewed for an expired share link', async () => {
    const link: FakeShareLink = {
      id: 'link-3',
      token: 'tok-exp',
      resourceType: 'photo',
      resourceId: 'photo-1',
      revoked: false,
      policy: { expiresAt: new Date(Date.now() - 1000).toISOString(), maxUses: null },
      useCount: 0,
    };
    const authz = new ImageAuthorizer(makeDataAdapter([link]));
    const granted = await authz.checkShareAccess('tok-exp', photoFixture());
    await bus.flush();

    expect(granted).toBe(false);
    expect(sink.events.filter((e) => e.type === 'share.viewed')).toHaveLength(0);
  });

  it('does NOT emit share.viewed when photo is outside the shared resource', async () => {
    const link: FakeShareLink = {
      id: 'link-4',
      token: 'tok-mis',
      resourceType: 'album',
      resourceId: 'album-other',
      revoked: false,
      policy: { expiresAt: null, maxUses: null },
      useCount: 0,
    };
    const authz = new ImageAuthorizer(makeDataAdapter([link]));
    const granted = await authz.checkShareAccess('tok-mis', photoFixture());
    await bus.flush();

    expect(granted).toBe(false);
    expect(sink.events.filter((e) => e.type === 'share.viewed')).toHaveLength(0);
  });

  it('does NOT emit share.viewed when share token is unknown', async () => {
    const authz = new ImageAuthorizer(makeDataAdapter([]));
    const granted = await authz.checkShareAccess('tok-nope', photoFixture());
    await bus.flush();

    expect(granted).toBe(false);
    expect(sink.events.filter((e) => e.type === 'share.viewed')).toHaveLength(0);
  });
});
