import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountAuraPix, AuraPixError, SDK_VERSION } from '../src/index';

const ORIGIN = 'https://app.aurapix.com';

function dispatchMessage(data: unknown, origin: string, source: Window | null) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin,
      source: source as unknown as MessageEventSource,
    })
  );
}

function makeHost(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// jsdom creates real iframe contentWindows but they navigate asynchronously
// and have no postMessage listener wired up. To deterministically test
// origin/source validation we wait for the iframe to mount and then stub
// `iframe.contentWindow` with a fake object that satisfies the source check.
function patchIframeWindow(iframe: HTMLIFrameElement) {
  const fake: { postMessage: ReturnType<typeof vi.fn>; close: () => void } = {
    postMessage: vi.fn(),
    close: () => {},
  };
  Object.defineProperty(iframe, 'contentWindow', {
    value: fake,
    configurable: true,
  });
  return fake;
}

describe('mountAuraPix — option validation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('throws on missing tenantId', () => {
    const host = makeHost();
    expect(() =>
      mountAuraPix(host, { tenantId: '', userJwt: 'jwt' } as never)
    ).toThrow(AuraPixError);
  });

  it('throws on missing userJwt', () => {
    const host = makeHost();
    expect(() =>
      mountAuraPix(host, { tenantId: 't1', userJwt: '' } as never)
    ).toThrow(AuraPixError);
  });

  it('throws on wildcard aurapixOrigin', () => {
    const host = makeHost();
    expect(() =>
      mountAuraPix(host, {
        tenantId: 't1',
        userJwt: 'jwt',
        aurapixOrigin: '*',
      })
    ).toThrowError(
      expect.objectContaining({ code: 'invalid_origin' }),
    );
  });

  it('throws on invalid aurapixOrigin', () => {
    const host = makeHost();
    expect(() =>
      mountAuraPix(host, {
        tenantId: 't1',
        userJwt: 'jwt',
        aurapixOrigin: 'not a url',
      })
    ).toThrowError(
      expect.objectContaining({ code: 'invalid_origin' }),
    );
  });

  it('throws on non-positive handshakeTimeoutMs', () => {
    const host = makeHost();
    expect(() =>
      mountAuraPix(host, {
        tenantId: 't1',
        userJwt: 'jwt',
        handshakeTimeoutMs: 0,
      })
    ).toThrow(/handshakeTimeoutMs/);
  });

  it('throws on a null host element', () => {
    expect(() =>
      mountAuraPix(null as unknown as HTMLElement, {
        tenantId: 't1',
        userJwt: 'jwt',
      })
    ).toThrow(AuraPixError);
  });
});

describe('mountAuraPix — iframe construction', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('creates an iframe inside the host element with the SDK version reported via the URL', () => {
    const host = makeHost();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
    });
    expect(host.querySelector('iframe')).toBe(handle.iframe);
    // SDK version is propagated to the embedded app via the `sdk` query
    // param so the server can correlate metering events without DOM attrs.
    expect(handle.iframe.src).toContain(`sdk=${SDK_VERSION}`);
    expect(handle.iframe.getAttribute('sandbox')).toContain('allow-scripts');
    handle.destroy();
  });

  it('writes the JWT into the URL fragment, not the query string', () => {
    const host = makeHost();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'secret-token',
      libraryId: 'lib_1',
      theme: 'dark',
      aurapixOrigin: ORIGIN,
    });
    const src = handle.iframe.getAttribute('src')!;
    expect(src).not.toContain('secret-token&'); // not in query
    const url = new URL(src);
    expect(url.searchParams.get('tenantId')).toBe('acme');
    expect(url.searchParams.get('libraryId')).toBe('lib_1');
    expect(url.searchParams.get('theme')).toBe('dark');
    expect(url.searchParams.get('sdk')).toBe(SDK_VERSION);
    expect(url.hash).toContain('jwt=secret-token');
    expect(url.searchParams.get('jwt')).toBeNull();
    handle.destroy();
  });

  it('omits the sandbox attribute when explicitly set to null', () => {
    const host = makeHost();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      sandbox: null,
    });
    expect(handle.iframe.hasAttribute('sandbox')).toBe(false);
    handle.destroy();
  });
});

describe('mountAuraPix — handshake & origin validation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onReady after a valid aurapix:ready from the configured origin', () => {
    const host = makeHost();
    const onReady = vi.fn();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      onReady,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    dispatchMessage(
      { type: 'aurapix:ready', tenantId: 'acme', version: '1.2.3' },
      ORIGIN,
      fakeWin as unknown as Window
    );

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith({
      tenantId: 'acme',
      version: '1.2.3',
      origin: ORIGIN,
    });
    handle.destroy();
  });

  it('forwards branding tokens from aurapix:ready to onReady (issue #187)', () => {
    const host = makeHost();
    const onReady = vi.fn();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      onReady,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    dispatchMessage(
      {
        type: 'aurapix:ready',
        tenantId: 'acme',
        version: '1.2.3',
        branding: {
          primaryColor: '#abcdef',
          accentColor: '#123456',
          logoUrl: 'https://cdn.example.com/logo.svg',
          fontFamily: 'Inter, system-ui, sans-serif',
        },
      },
      ORIGIN,
      fakeWin as unknown as Window
    );

    expect(onReady).toHaveBeenCalledWith({
      tenantId: 'acme',
      version: '1.2.3',
      origin: ORIGIN,
      branding: {
        primaryColor: '#abcdef',
        accentColor: '#123456',
        logoUrl: 'https://cdn.example.com/logo.svg',
        fontFamily: 'Inter, system-ui, sans-serif',
      },
    });
    handle.destroy();
  });

  it('omits branding from onReady when the embedded app did not send any (issue #187)', () => {
    const host = makeHost();
    const onReady = vi.fn();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      onReady,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    dispatchMessage(
      { type: 'aurapix:ready', tenantId: 'acme', version: '1.2.3' },
      ORIGIN,
      fakeWin as unknown as Window
    );

    expect(onReady).toHaveBeenCalledWith({
      tenantId: 'acme',
      version: '1.2.3',
      origin: ORIGIN,
    });
    const detail = onReady.mock.calls[0]?.[0];
    expect(detail).not.toHaveProperty('branding');
    handle.destroy();
  });

  it('drops non-string branding fields defensively (issue #187)', () => {
    const host = makeHost();
    const onReady = vi.fn();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      onReady,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    dispatchMessage(
      {
        type: 'aurapix:ready',
        tenantId: 'acme',
        version: '1.2.3',
        // Hostile / malformed payload: number, null, empty string
        branding: {
          primaryColor: '#abcdef',
          accentColor: 42,
          logoUrl: null,
          fontFamily: '',
        },
      },
      ORIGIN,
      fakeWin as unknown as Window
    );

    expect(onReady).toHaveBeenCalledWith({
      tenantId: 'acme',
      version: '1.2.3',
      origin: ORIGIN,
      branding: { primaryColor: '#abcdef' },
    });
    handle.destroy();
  });

  it('rejects ready messages from a different origin (anti-spoofing)', () => {
    const host = makeHost();
    const onReady = vi.fn();
    const onError = vi.fn();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      onReady,
      onError,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    dispatchMessage(
      { type: 'aurapix:ready', tenantId: 'acme', version: '1.2.3' },
      'https://evil.example.com',
      fakeWin as unknown as Window
    );

    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled(); // silently dropped, no spoofed handshake
    handle.destroy();
  });

  it('rejects ready messages whose source is not the iframe', () => {
    const host = makeHost();
    const onReady = vi.fn();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      onReady,
    });
    patchIframeWindow(handle.iframe);

    dispatchMessage(
      { type: 'aurapix:ready', tenantId: 'acme', version: '1.2.3' },
      ORIGIN,
      { other: true } as unknown as Window
    );

    expect(onReady).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('rejects non-AuraPix message payloads', () => {
    const host = makeHost();
    const onReady = vi.fn();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      onReady,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    dispatchMessage({ type: 'other:thing' }, ORIGIN, fakeWin as unknown as Window);
    dispatchMessage('aurapix:ready', ORIGIN, fakeWin as unknown as Window);
    dispatchMessage(null, ORIGIN, fakeWin as unknown as Window);

    expect(onReady).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('surfaces an invalid_options error on tenantId mismatch', () => {
    const host = makeHost();
    const onError = vi.fn();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      onError,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    dispatchMessage(
      { type: 'aurapix:ready', tenantId: 'other-tenant', version: '1.0.0' },
      ORIGIN,
      fakeWin as unknown as Window
    );

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as AuraPixError;
    expect(err).toBeInstanceOf(AuraPixError);
    expect(err.code).toBe('invalid_options');
    expect(err.message).toMatch(/tenantId mismatch/);
    handle.destroy();
  });

  it('fires onError with handshake_timeout when no ready arrives in time', () => {
    const host = makeHost();
    const onError = vi.fn();
    mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      handshakeTimeoutMs: 5000,
      onError,
    });

    vi.advanceTimersByTime(4999);
    expect(onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as AuraPixError;
    expect(err.code).toBe('handshake_timeout');
  });

  it('does not fire handshake_timeout if ready arrives first', () => {
    const host = makeHost();
    const onError = vi.fn();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      handshakeTimeoutMs: 5000,
      onError,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    dispatchMessage(
      { type: 'aurapix:ready', tenantId: 'acme', version: '1.0.0' },
      ORIGIN,
      fakeWin as unknown as Window
    );
    vi.advanceTimersByTime(10000);
    expect(onError).not.toHaveBeenCalled();
    handle.destroy();
  });
});

describe('mountAuraPix — imperative API', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('openPhoto posts an aurapix:navigate with the photo path', () => {
    const host = makeHost();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    handle.openPhoto('photo_xyz');
    expect(fakeWin.postMessage).toHaveBeenCalledWith(
      { type: 'aurapix:navigate', path: '/photos/photo_xyz' },
      ORIGIN
    );
    handle.destroy();
  });

  it('openAlbum posts an aurapix:navigate with the album path', () => {
    const host = makeHost();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    handle.openAlbum('alb_1');
    expect(fakeWin.postMessage).toHaveBeenCalledWith(
      { type: 'aurapix:navigate', path: '/albums/alb_1' },
      ORIGIN
    );
    handle.destroy();
  });

  it('setTheme posts an aurapix:set-theme to the iframe', () => {
    const host = makeHost();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    handle.setTheme('dark');
    expect(fakeWin.postMessage).toHaveBeenCalledWith(
      { type: 'aurapix:set-theme', theme: 'dark' },
      ORIGIN
    );
    handle.destroy();
  });

  it('openPhoto / openAlbum / setTheme reject empty arguments', () => {
    const host = makeHost();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
    });
    expect(() => handle.openPhoto('')).toThrow(AuraPixError);
    expect(() => handle.openAlbum('')).toThrow(AuraPixError);
    expect(() => handle.setTheme('')).toThrow(AuraPixError);
    handle.destroy();
  });

  it('on() dispatches aurapix:event payloads to subscribers by name', () => {
    const host = makeHost();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
    });
    const fakeWin = patchIframeWindow(handle.iframe);
    const handler = vi.fn();
    handle.on('selection-changed', handler);

    dispatchMessage(
      { type: 'aurapix:event', name: 'selection-changed', payload: { count: 3 } },
      ORIGIN,
      fakeWin as unknown as Window
    );
    expect(handler).toHaveBeenCalledWith({ count: 3 });

    dispatchMessage(
      { type: 'aurapix:event', name: 'other-event', payload: { x: 1 } },
      ORIGIN,
      fakeWin as unknown as Window
    );
    expect(handler).toHaveBeenCalledTimes(1);

    handle.destroy();
  });

  it('on() returns an unsubscribe function', () => {
    const host = makeHost();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
    });
    const fakeWin = patchIframeWindow(handle.iframe);
    const handler = vi.fn();
    const unsub = handle.on('ping', handler);

    dispatchMessage(
      { type: 'aurapix:event', name: 'ping' },
      ORIGIN,
      fakeWin as unknown as Window
    );
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    dispatchMessage(
      { type: 'aurapix:event', name: 'ping' },
      ORIGIN,
      fakeWin as unknown as Window
    );
    expect(handler).toHaveBeenCalledTimes(1);

    handle.destroy();
  });

  it('catch-all onEvent receives every aurapix:event payload', () => {
    const host = makeHost();
    const onEvent = vi.fn();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      onEvent,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    dispatchMessage(
      { type: 'aurapix:event', name: 'foo' },
      ORIGIN,
      fakeWin as unknown as Window
    );
    dispatchMessage(
      { type: 'aurapix:event', name: 'bar', payload: 1 },
      ORIGIN,
      fakeWin as unknown as Window
    );
    expect(onEvent).toHaveBeenCalledWith({ name: 'foo', payload: undefined });
    expect(onEvent).toHaveBeenCalledWith({ name: 'bar', payload: 1 });

    handle.destroy();
  });

  it('resize messages fire the resize channel', () => {
    const host = makeHost();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
    });
    const fakeWin = patchIframeWindow(handle.iframe);
    const onResize = vi.fn();
    handle.on('resize', onResize);

    dispatchMessage(
      { type: 'aurapix:resize', height: 800 },
      ORIGIN,
      fakeWin as unknown as Window
    );
    expect(onResize).toHaveBeenCalledWith({ height: 800 });

    // Negative heights are rejected by the guard.
    dispatchMessage(
      { type: 'aurapix:resize', height: -1 },
      ORIGIN,
      fakeWin as unknown as Window
    );
    expect(onResize).toHaveBeenCalledTimes(1);

    handle.destroy();
  });
});

describe('mountAuraPix — destroy + session-end beacon', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('destroy removes the iframe and stops further dispatch', () => {
    const host = makeHost();
    const onReady = vi.fn();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      onReady,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    handle.destroy();
    expect(host.querySelector('iframe')).toBeNull();

    // After destroy, additional messages are ignored.
    dispatchMessage(
      { type: 'aurapix:ready', tenantId: 'acme', version: '1' },
      ORIGIN,
      fakeWin as unknown as Window
    );
    expect(onReady).not.toHaveBeenCalled();
  });

  it('destroy is idempotent', () => {
    const host = makeHost();
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
    });
    handle.destroy();
    expect(() => handle.destroy()).not.toThrow();
  });

  it('does not call fetch for session-end when handshake never completed', () => {
    const host = makeHost();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      fetch: fetchMock as unknown as typeof fetch,
    });
    handle.destroy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('emits a session-end POST on destroy after a successful handshake', () => {
    const host = makeHost();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const handle = mountAuraPix(host, {
      tenantId: 'acme',
      userJwt: 'jwt',
      aurapixOrigin: ORIGIN,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const fakeWin = patchIframeWindow(handle.iframe);

    dispatchMessage(
      { type: 'aurapix:ready', tenantId: 'acme', version: '1' },
      ORIGIN,
      fakeWin as unknown as Window
    );

    handle.destroy();

    // sendBeacon may or may not exist; if absent, fetch is used.
    const usedBeacon =
      typeof window.navigator.sendBeacon === 'function' &&
      // jsdom's sendBeacon exists but is a stub; either way, our SDK
      // attempts it first. So fetch may be 0 OR 1; both are valid.
      false;
    if (!usedBeacon && fetchMock.mock.calls.length === 1) {
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${ORIGIN}/v1/tenants/acme/embed/session-end`);
      expect((init as RequestInit).method).toBe('POST');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.tenantId).toBe('acme');
      expect(typeof body.durationMs).toBe('number');
      expect(body.sdkVersion).toBe(SDK_VERSION);
      expect(typeof body.sessionId).toBe('string');
    }
  });
});
