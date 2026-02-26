import { InMemorySharingService } from './inMemorySharingService';

describe('InMemorySharingService', () => {
  it('enforces password policy and records deny/grant access events', async () => {
    const service = new InMemorySharingService();

    const link = await service.createShareLink({
      resourceType: 'album',
      resourceId: 'album-1',
      policy: { permission: 'download' },
      password: 'open-sesame',
    });

    const missingPassword = await service.resolveShareLink({ token: link.token });
    const badPassword = await service.resolveShareLink({ token: link.token, password: 'wrong' });
    const success = await service.resolveShareLink({ token: link.token, password: 'open-sesame' });

    expect(missingPassword).toBeNull();
    expect(badPassword).toBeNull();
    expect(success?.id).toBe(link.id);

    const events = await service.listAccessEvents('album-1');
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.outcome)).toEqual([
      'granted',
      'denied_invalid_password',
      'denied_invalid_password',
    ]);
  });

  it('blocks max-use links after quota and records denial', async () => {
    const service = new InMemorySharingService();

    const link = await service.createShareLink({
      resourceType: 'photo',
      resourceId: 'photo-22',
      policy: { maxUses: 1 },
    });

    const first = await service.resolveShareLink({ token: link.token });
    const second = await service.resolveShareLink({ token: link.token });

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const events = await service.listAccessEvents('photo-22');
    expect(events.map((event) => event.outcome)).toEqual(['denied_max_uses', 'granted']);
  });
});
