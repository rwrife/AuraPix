import { describe, it, expect, vi } from 'vitest';
import {
  createEmbedHost,
  isAuraPixMessage,
  isAuraPixReady,
  isAuraPixResize,
  isAuraPixEvent,
  AURAPIX_MESSAGE_TYPES,
  type AuraPixOutboundMessage,
  type AuraPixInboundMessage,
} from './host-sdk';
import { createEmbedded } from './embedded';

interface FakeWindow {
  close?: () => void;
  postMessage?: (msg: unknown, targetOrigin: string) => void;
}

function makeIframe(
  contentWindow: FakeWindow | null = null
): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  // jsdom doesn't fully wire up about:blank iframes; fake the contentWindow
  // when tests pass one in (so message routing tests don't depend on real
  // navigation). jsdom's teardown walks iframe.contentWindow.close(), so the
  // fake window MUST expose a no-op `close`.
  if (contentWindow) {
    if (typeof contentWindow.close !== 'function') {
      contentWindow.close = () => {};
    }
    Object.defineProperty(iframe, 'contentWindow', {
      value: contentWindow,
      configurable: true,
    });
  }
  document.body.appendChild(iframe);
  return iframe;
}

describe('isAuraPixMessage guards', () => {
  it('accepts well-formed messages', () => {
    expect(isAuraPixMessage({ type: 'aurapix:ready', tenantId: 't', version: '1' })).toBe(true);
    expect(isAuraPixReady({ type: 'aurapix:ready', tenantId: 't', version: '1' })).toBe(true);
    expect(isAuraPixResize({ type: 'aurapix:resize', height: 800 })).toBe(true);
    expect(isAuraPixEvent({ type: 'aurapix:event', name: 'foo' })).toBe(true);
  });

  it('rejects unknown / malformed payloads', () => {
    expect(isAuraPixMessage(null)).toBe(false);
    expect(isAuraPixMessage('aurapix:ready')).toBe(false);
    expect(isAuraPixMessage({ type: 'other:thing' })).toBe(false);
    expect(isAuraPixReady({ type: 'aurapix:ready' })).toBe(false);
    expect(isAuraPixResize({ type: 'aurapix:resize', height: -1 })).toBe(false);
    expect(isAuraPixResize({ type: 'aurapix:resize', height: 'tall' })).toBe(false);
    expect(isAuraPixEvent({ type: 'aurapix:event' })).toBe(false);
  });

  it('accepts aurapix:ready with optional branding tokens (issue #187)', () => {
    expect(
      isAuraPixReady({
        type: 'aurapix:ready',
        tenantId: 't',
        version: '1',
        branding: { primaryColor: '#2563eb' },
      })
    ).toBe(true);
    expect(
      isAuraPixReady({
        type: 'aurapix:ready',
        tenantId: 't',
        version: '1',
        branding: {},
      })
    ).toBe(true);
  });

  it('rejects aurapix:ready with malformed branding payload', () => {
    expect(
      isAuraPixReady({
        type: 'aurapix:ready',
        tenantId: 't',
        version: '1',
        branding: { primaryColor: 42 },
      })
    ).toBe(false);
    expect(
      isAuraPixReady({
        type: 'aurapix:ready',
        tenantId: 't',
        version: '1',
        branding: 'not-an-object',
      })
    ).toBe(false);
  });
});

describe('createEmbedHost', () => {
  it('throws on wildcard targetOrigin', () => {
    const iframe = makeIframe();
    expect(() =>
      createEmbedHost({ iframe, targetOrigin: '*' })
    ).toThrow(/exact origin/);
  });

  it('throws on invalid targetOrigin', () => {
    const iframe = makeIframe();
    expect(() =>
      createEmbedHost({ iframe, targetOrigin: 'not a url' })
    ).toThrow(/invalid targetOrigin/);
  });

  it('forwards messages from the iframe origin to listeners', () => {
    const fakeIframeWin: FakeWindow = {};
    const iframe = makeIframe(fakeIframeWin);
    const handle = createEmbedHost({
      iframe,
      targetOrigin: 'https://app.aurapix.com',
    });
    const seen: AuraPixOutboundMessage[] = [];
    const unsub = handle.on((msg) => seen.push(msg));

    // Dispatch a synthetic MessageEvent matching the iframe's origin/source.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'aurapix:ready', tenantId: 'acme', version: '1.0.0' },
        origin: 'https://app.aurapix.com',
        source: fakeIframeWin as unknown as Window,
      })
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'aurapix:ready', tenantId: 'acme' });

    unsub();
    handle.dispose();
  });

  it('forwards branding tokens end-to-end from embedded ready() to host listener (issue #187)', () => {
    // The handshake is fan-out from the embedded UI to every allowed
    // parent origin. From the host side we just need to verify that an
    // `aurapix:ready` with a `branding` block is delivered intact to the
    // listener (i.e. createEmbedHost's outbound filter doesn't strip the
    // additive field).
    const fakeIframeWin: FakeWindow = {};
    const iframe = makeIframe(fakeIframeWin);
    const handle = createEmbedHost({
      iframe,
      targetOrigin: 'https://app.aurapix.com',
    });
    const seen: AuraPixOutboundMessage[] = [];
    handle.on((msg) => seen.push(msg));

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'aurapix:ready',
          tenantId: 'acme',
          version: '1.0.0',
          branding: {
            primaryColor: '#abcdef',
            accentColor: '#123456',
            logoUrl: 'https://cdn.example.com/logo.svg',
          },
        },
        origin: 'https://app.aurapix.com',
        source: fakeIframeWin as unknown as Window,
      })
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'aurapix:ready',
      tenantId: 'acme',
      branding: {
        primaryColor: '#abcdef',
        accentColor: '#123456',
        logoUrl: 'https://cdn.example.com/logo.svg',
      },
    });
    handle.dispose();
  });

  it('drops messages from disallowed origins', () => {
    const fakeIframeWin: FakeWindow = {};
    const iframe = makeIframe(fakeIframeWin);
    const handle = createEmbedHost({
      iframe,
      targetOrigin: 'https://app.aurapix.com',
    });
    const seen: AuraPixOutboundMessage[] = [];
    handle.on((m) => seen.push(m));

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'aurapix:ready', tenantId: 'acme', version: '1.0.0' },
        origin: 'https://evil.example.com',
        source: fakeIframeWin as unknown as Window,
      })
    );
    // Also drop messages from the right origin but a different source window.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'aurapix:resize', height: 500 },
        origin: 'https://app.aurapix.com',
        source: window as unknown as Window,
      })
    );
    // Also drop messages that don't match the prefix.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'other:thing' },
        origin: 'https://app.aurapix.com',
        source: fakeIframeWin as unknown as Window,
      })
    );

    expect(seen).toHaveLength(0);
    handle.dispose();
  });

  it('only forwards outbound message types upward', () => {
    const fakeIframeWin: FakeWindow = {};
    const iframe = makeIframe(fakeIframeWin);
    const handle = createEmbedHost({
      iframe,
      targetOrigin: 'https://app.aurapix.com',
    });
    const seen: AuraPixOutboundMessage[] = [];
    handle.on((m) => seen.push(m));

    // A spoofed `aurapix:set-theme` (an inbound type) must NOT be forwarded
    // to host listeners — that's a one-way host → embedded message.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'aurapix:set-theme', theme: 'dark' },
        origin: 'https://app.aurapix.com',
        source: fakeIframeWin as unknown as Window,
      })
    );

    expect(seen).toHaveLength(0);
    handle.dispose();
  });

  it('setTheme / navigate post to the iframe', () => {
    const post = vi.fn();
    const fakeIframeWin: FakeWindow = { postMessage: post };
    const iframe = makeIframe(fakeIframeWin);
    const handle = createEmbedHost({
      iframe,
      targetOrigin: 'https://app.aurapix.com',
    });

    handle.setTheme('dark');
    handle.navigate('/photos/123');

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(
      1,
      { type: AURAPIX_MESSAGE_TYPES.setTheme, theme: 'dark' },
      'https://app.aurapix.com'
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      { type: AURAPIX_MESSAGE_TYPES.navigate, path: '/photos/123' },
      'https://app.aurapix.com'
    );

    handle.dispose();
  });

  it('navigate rejects paths without a leading slash', () => {
    const fakeIframeWin: FakeWindow = { postMessage: vi.fn() };
    const iframe = makeIframe(fakeIframeWin);
    const handle = createEmbedHost({
      iframe,
      targetOrigin: 'https://app.aurapix.com',
    });
    expect(() => handle.navigate('photos')).toThrow();
    handle.dispose();
  });

  it('dispose stops listener dispatch and outbound sends', () => {
    const post = vi.fn();
    const fakeIframeWin: FakeWindow = { postMessage: post };
    const iframe = makeIframe(fakeIframeWin);
    const handle = createEmbedHost({
      iframe,
      targetOrigin: 'https://app.aurapix.com',
    });
    const seen: AuraPixOutboundMessage[] = [];
    handle.on((m) => seen.push(m));

    handle.dispose();
    handle.setTheme('dark');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'aurapix:ready', tenantId: 'acme', version: '1' },
        origin: 'https://app.aurapix.com',
        source: fakeIframeWin as unknown as Window,
      })
    );

    expect(post).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });
});

describe('createEmbedded', () => {
  it('ready() posts an aurapix:ready to every allowed origin', () => {
    const parentPost = vi.fn();
    const parentRef = { postMessage: parentPost };
    const fakeWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      parent: parentRef,
    } as unknown as Window;

    const handle = createEmbedded({
      tenantId: 'acme',
      version: '1.2.3',
      allowedOrigins: ['https://host-a.example.com', 'https://host-b.example.com'],
      window: fakeWindow,
    });

    handle.ready();
    expect(parentPost).toHaveBeenCalledTimes(2);
    expect(parentPost).toHaveBeenCalledWith(
      { type: 'aurapix:ready', tenantId: 'acme', version: '1.2.3' },
      'https://host-a.example.com'
    );
    expect(parentPost).toHaveBeenCalledWith(
      { type: 'aurapix:ready', tenantId: 'acme', version: '1.2.3' },
      'https://host-b.example.com'
    );

    handle.dispose();
  });

  it('ready(branding) includes optional branding tokens (issue #187)', () => {
    const parentPost = vi.fn();
    const parentRef = { postMessage: parentPost };
    const fakeWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      parent: parentRef,
    } as unknown as Window;

    const handle = createEmbedded({
      tenantId: 'acme',
      version: '1.0.0',
      allowedOrigins: ['https://host.example.com'],
      window: fakeWindow,
    });

    // No branding — field is omitted from the envelope so hosts on the
    // wire-snapshot path stay backward-compatible.
    handle.ready();
    expect(parentPost).toHaveBeenCalledWith(
      { type: 'aurapix:ready', tenantId: 'acme', version: '1.0.0' },
      'https://host.example.com'
    );
    expect((parentPost.mock.calls[0][0] as Record<string, unknown>).branding).toBeUndefined();

    parentPost.mockClear();
    handle.ready({ primaryColor: '#abcdef', logoUrl: 'https://cdn.example.com/logo.svg' });
    expect(parentPost).toHaveBeenCalledWith(
      {
        type: 'aurapix:ready',
        tenantId: 'acme',
        version: '1.0.0',
        branding: { primaryColor: '#abcdef', logoUrl: 'https://cdn.example.com/logo.svg' },
      },
      'https://host.example.com'
    );

    handle.dispose();
  });

  it('does not leak internal record fields into the branding payload (snapshot)', () => {
    // Snapshot test on the payload shape — part of the issue #187
    // acceptance criteria: no secret/internal fields are leaked through
    // the handshake.
    const parentPost = vi.fn();
    const parentRef = { postMessage: parentPost };
    const fakeWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      parent: parentRef,
    } as unknown as Window;

    const handle = createEmbedded({
      tenantId: 'acme',
      version: '1.0.0',
      allowedOrigins: ['https://host.example.com'],
      window: fakeWindow,
    });
    handle.ready({
      primaryColor: '#2563eb',
      accentColor: '#7c3aed',
      logoUrl: 'https://cdn.example.com/logo.svg',
      fontFamily: 'Inter, system-ui, sans-serif',
    });

    expect(parentPost).toHaveBeenCalledTimes(1);
    const sent = parentPost.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      'branding',
      'tenantId',
      'type',
      'version',
    ]);
    expect(Object.keys(sent.branding as object).sort()).toEqual([
      'accentColor',
      'fontFamily',
      'logoUrl',
      'primaryColor',
    ]);
    // Explicitly assert none of the internal record fields leak.
    for (const forbidden of ['tenantId', 'updatedAt', 'apiKey', 'faviconUrl']) {
      expect((sent.branding as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
    handle.dispose();
  });

  it('ignores inbound messages from disallowed origins', () => {
    let captured: ((event: MessageEvent) => void) | null = null;
    const parentRef = { postMessage: vi.fn() };
    const fakeWindow = {
      addEventListener: (_t: string, cb: (event: MessageEvent) => void) => {
        captured = cb;
      },
      removeEventListener: vi.fn(),
      parent: parentRef,
    } as unknown as Window;

    const handle = createEmbedded({
      tenantId: 'acme',
      version: '1.0.0',
      allowedOrigins: ['https://host.example.com'],
      window: fakeWindow,
    });

    const seen: AuraPixInboundMessage[] = [];
    handle.on((m) => seen.push(m));

    if (!captured) throw new Error('listener not registered');
    const dispatch = captured as (event: MessageEvent) => void;

    // From a disallowed origin → dropped.
    dispatch({
      data: { type: 'aurapix:set-theme', theme: 'dark' },
      origin: 'https://evil.example.com',
      source: parentRef,
    } as unknown as MessageEvent);

    // From the allowed origin but wrong source → dropped.
    dispatch({
      data: { type: 'aurapix:set-theme', theme: 'dark' },
      origin: 'https://host.example.com',
      source: { other: true },
    } as unknown as MessageEvent);

    // From the allowed origin AND the parent → forwarded.
    dispatch({
      data: { type: 'aurapix:set-theme', theme: 'dark' },
      origin: 'https://host.example.com',
      source: parentRef,
    } as unknown as MessageEvent);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'aurapix:set-theme', theme: 'dark' });
    handle.dispose();
  });
});
