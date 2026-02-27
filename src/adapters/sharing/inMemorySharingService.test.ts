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
    expect(events.every((event) => event.attempt === 'link_resolve')).toBe(true);
    expect(events.every((event) => event.resourceType === 'album')).toBe(true);
    expect(events.every((event) => event.resourceId === 'album-1')).toBe(true);
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

  it('enforces download policies and deterministic watermark behavior', async () => {
    const service = new InMemorySharingService();

    const derivativeOnly = await service.createShareLink({
      resourceType: 'photo',
      resourceId: 'photo-77',
      policy: {
        permission: 'download',
        downloadPolicy: 'derivative_only',
        watermarkEnabled: true,
      },
    });

    const blockedOriginal = await service.resolveShareDownload({
      token: derivativeOnly.token,
      assetKind: 'original',
    });
    const derivativeAllowed = await service.resolveShareDownload({
      token: derivativeOnly.token,
      assetKind: 'derivative',
    });

    expect(blockedOriginal).toBeNull();
    expect(derivativeAllowed?.assetKind).toBe('derivative');
    expect(derivativeAllowed?.watermarkApplied).toBe(true);

    const noDownload = await service.createShareLink({
      resourceType: 'photo',
      resourceId: 'photo-77',
      policy: { downloadPolicy: 'none' },
    });
    const blockedDerivative = await service.resolveShareDownload({
      token: noDownload.token,
      assetKind: 'derivative',
    });

    expect(blockedDerivative).toBeNull();

    const events = await service.listAccessEvents('photo-77');
    expect(events.map((event) => event.outcome)).toEqual([
      'denied_download_disallowed',
      'granted_download',
      'denied_download_disallowed',
    ]);
    expect(events.map((event) => event.attempt)).toEqual([
      'download_derivative',
      'download_derivative',
      'download_original',
    ]);
  });
});


  it('updates share link download policy with safe defaults', async () => {
    const service = new InMemorySharingService();

    const link = await service.createShareLink({
      resourceType: 'album',
      resourceId: 'album-2',
      policy: { permission: 'download', downloadPolicy: 'derivative_only', watermarkEnabled: true },
    });

    const disabledDownloads = await service.updateShareLinkPolicy({
      linkId: link.id,
      policy: { downloadPolicy: 'none' },
    });
    expect(disabledDownloads.policy.downloadPolicy).toBe('none');
    expect(disabledDownloads.policy.watermarkEnabled).toBe(false);

    const restored = await service.updateShareLinkPolicy({
      linkId: link.id,
      policy: { permission: 'download' },
    });
    expect(restored.policy.downloadPolicy).toBe('original_and_derivative');
  });
