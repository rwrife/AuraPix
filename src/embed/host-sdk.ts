/**
 * AuraPix Embed Host SDK — wraps the documented postMessage handshake for
 * host applications iframing AuraPix. See `docs/features/embed-handshake.md`.
 *
 * Dependency-free ESM; the message contract lives in `./contract.ts`.
 */
import {
  AURAPIX_MESSAGE_TYPES,
  isAuraPixMessage,
  type AuraPixInboundMessage,
  type AuraPixOutboundMessage,
  type AuraPixSetThemeMessage,
} from './contract.js';

export interface CreateEmbedHostOptions {
  /** The iframe element hosting AuraPix; must already be in the DOM. */
  iframe: HTMLIFrameElement;
  /** Exact AuraPix origin (e.g. `https://app.aurapix.com`). Never `'*'`. */
  targetOrigin: string;
  /** `window` reference — defaults to the global `window`. */
  window?: Window;
  /**
   * Optional host-issued embed session token (issue #195). When set, the
   * host SDK forwards it as the first `aurapix:session` postMessage as
   * soon as the embedded UI announces `aurapix:ready`. The embedded UI
   * exchanges the token for a server-side session and the user lands
   * inside AuraPix without seeing the Firebase login UI.
   *
   * Mint a token via `POST /v1/tenants/{tenantId}/embed/session-tokens`
   * (host API key, `tenants.write` scope). Tokens are single-use and
   * short-lived (TTL ≤ 300s).
   */
  sessionToken?: string;
}

export type EmbedHostListener = (
  message: AuraPixOutboundMessage,
  event: MessageEvent
) => void;

export interface EmbedHostHandle {
  on(listener: EmbedHostListener): () => void;
  setTheme(theme: AuraPixSetThemeMessage['theme']): void;
  navigate(path: string): void;
  /**
   * Send (or replace) the host-issued embed session token (issue #195).
   * Callers can also pass it via `createEmbedHost({ sessionToken })` and
   * the SDK will auto-forward as soon as `aurapix:ready` arrives.
   */
  sendSessionToken(token: string): void;
  dispose(): void;
}

/**
 * Wire up the postMessage handshake on the host side. Inbound messages
 * from origins other than `targetOrigin`, or whose `source` is not the
 * iframe's `contentWindow`, are silently dropped.
 *
 * @throws on `'*'`, empty, or syntactically invalid `targetOrigin`.
 */
export function createEmbedHost(opts: CreateEmbedHostOptions): EmbedHostHandle {
  const w = opts.window ?? globalThis.window;
  if (!w || typeof w.addEventListener !== 'function') {
    throw new Error('createEmbedHost requires a browser window');
  }
  if (!opts.targetOrigin || opts.targetOrigin === '*') {
    throw new Error('createEmbedHost: targetOrigin must be an exact origin');
  }
  let parsedOrigin: string;
  try {
    parsedOrigin = new URL(opts.targetOrigin).origin;
  } catch {
    throw new Error(`createEmbedHost: invalid targetOrigin "${opts.targetOrigin}"`);
  }
  if (parsedOrigin === 'null') {
    throw new Error('createEmbedHost: targetOrigin resolved to "null" origin');
  }

  const listeners = new Set<EmbedHostListener>();
  let disposed = false;
  // Issue #195: queued session token — sent after `aurapix:ready` arrives
  // so the embedded UI is guaranteed to have its postMessage listener
  // wired up before we hand it the credential. We also drop the token
  // from memory after sending so it isn't trivially exfiltrable from a
  // long-lived host page.
  let pendingSessionToken: string | null =
    typeof opts.sessionToken === 'string' && opts.sessionToken.length > 0
      ? opts.sessionToken
      : null;
  let readySeen = false;

  const send = (message: AuraPixInboundMessage): void => {
    if (disposed) return;
    const target = opts.iframe.contentWindow;
    if (target) target.postMessage(message, parsedOrigin);
  };

  const flushSessionToken = (): void => {
    if (!pendingSessionToken) return;
    const token = pendingSessionToken;
    pendingSessionToken = null;
    send({ type: AURAPIX_MESSAGE_TYPES.session, token });
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    if (event.origin !== parsedOrigin) return;
    if (event.source !== opts.iframe.contentWindow) return;
    if (!isAuraPixMessage(event.data)) return;
    const t = event.data.type;
    if (
      t !== AURAPIX_MESSAGE_TYPES.ready &&
      t !== AURAPIX_MESSAGE_TYPES.resize &&
      t !== AURAPIX_MESSAGE_TYPES.event
    ) {
      return;
    }
    // Issue #195: send the queued session token as soon as the embedded
    // UI announces it's ready. This guarantees the embedded message
    // handler is mounted before we hand it the credential.
    if (t === AURAPIX_MESSAGE_TYPES.ready && !readySeen) {
      readySeen = true;
      flushSessionToken();
    }
    for (const l of listeners) {
      try {
        l(event.data as AuraPixOutboundMessage, event);
      } catch {
        // Listener errors must not break dispatch.
      }
    }
  };

  w.addEventListener('message', onMessage);

  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTheme(theme) {
      send({ type: AURAPIX_MESSAGE_TYPES.setTheme, theme });
    },
    navigate(path) {
      if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new Error('navigate: path must start with "/"');
      }
      send({ type: AURAPIX_MESSAGE_TYPES.navigate, path });
    },
    sendSessionToken(token) {
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('sendSessionToken: token must be a non-empty string');
      }
      // If `aurapix:ready` has already arrived, send immediately;
      // otherwise queue so the SDK can flush on ready.
      if (readySeen) {
        send({ type: AURAPIX_MESSAGE_TYPES.session, token });
      } else {
        pendingSessionToken = token;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      w.removeEventListener('message', onMessage);
      listeners.clear();
    },
  };
}

// Re-export the contract so consumers only need one import path.
export * from './contract.js';
