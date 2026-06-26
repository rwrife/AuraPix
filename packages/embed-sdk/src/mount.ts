/**
 * AuraPix embed mount — internal implementation.
 *
 * Wraps the postMessage handshake (issue #163) in a tiny imperative API:
 *
 *   const handle = mountAuraPix(el, opts);
 *   handle.openPhoto('photo_xyz');
 *   handle.destroy();
 *
 * Strictly client-side. Zero runtime dependencies.
 */

/** Build-time SDK version. Bumped on each release. */
export const SDK_VERSION = '0.1.0';

/** Default AuraPix origin used when {@link MountAuraPixOptions.aurapixOrigin}
 * is not provided. Overridable for dev / on-prem installations. */
export const DEFAULT_AURAPIX_ORIGIN = 'https://app.aurapix.com';

/** Default handshake timeout. Matches issue #177 acceptance criteria
 * ("ready handshake completes within 5s or onError fires"). */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

/** UI theme forwarded to the embedded app. */
export type AuraPixTheme = 'light' | 'dark' | 'auto' | (string & {});

/** Public-safe branding tokens forwarded by the embedded app (issue #187).
 *
 * Strictly read-only — the SDK only surfaces the field so the host page
 * can mirror tenant colors in its surrounding chrome without a second
 * network round-trip. Omitted when the tenant has not configured any
 * non-default branding (hosts fall back to their own defaults). Contains
 * only public-safe values — no API keys, no internal IDs. */
export interface AuraPixBrandingTokens {
  /** Hex primary brand color (e.g. `#2563eb`). */
  primaryColor?: string;
  /** Hex accent brand color (e.g. `#7c3aed`). */
  accentColor?: string;
  /** Public logo URL (typically an HTTPS asset). */
  logoUrl?: string;
  /** CSS `font-family` value the host can mirror. */
  fontFamily?: string;
}

/** Payload delivered to {@link MountAuraPixOptions.onReady}. */
export interface AuraPixReadyDetail {
  /** Tenant id reported by the embedded app — should match `opts.tenantId`. */
  tenantId: string;
  /** Embedded build version (SemVer). */
  version: string;
  /** AuraPix origin the iframe is loaded from. */
  origin: string;
  /**
   * Optional tenant branding tokens (issue #187). Present only when the
   * tenant has configured non-default branding; hosts should fall back
   * to their own defaults otherwise.
   */
  branding?: AuraPixBrandingTokens;
}

/** All error codes the SDK surfaces. Stable strings safe for switch/case. */
export type AuraPixErrorCode =
  | 'invalid_element'
  | 'invalid_origin'
  | 'invalid_options'
  | 'handshake_timeout'
  | 'destroyed';

/** Typed error class. Always thrown / passed through {@link AuraPixEventHandler}. */
export class AuraPixError extends Error {
  // Declared via `declare` to avoid TS' class-field initialization which
  // esbuild expands into ~100 bytes of `defineProperty` boilerplate.
  declare code: AuraPixErrorCode;
  constructor(code: AuraPixErrorCode, message: string) {
    super(message);
    this.name = 'AuraPixError';
    this.code = code;
  }
}

/** Forwarded UI event names emitted via {@link MountAuraPixOptions.onEvent}
 * and {@link AuraPixHandle.on}. The catalogue is intentionally open — the
 * embedded app may add new event names without an SDK release. */
export type AuraPixEventName = 'ready' | 'error' | 'resize' | (string & {});

export type AuraPixEventHandler<P = unknown> = (payload: P) => void;

export interface MountAuraPixOptions {
  /** Tenant id this embed is for. Mismatch with the JWT claims → backend
   * rejects the session and the SDK surfaces a typed `invalid_options` error. */
  tenantId: string;
  /** Per-user JWT minted by the host backend (signed with the host API
   * key, server-to-server). The SDK never sees the API key itself. */
  userJwt: string;
  /** Optional library id to focus on at mount. */
  libraryId?: string;
  /** UI theme. Defaults to `'auto'`. */
  theme?: AuraPixTheme;
  /** AuraPix origin (e.g. `https://app.aurapix.com`, or `http://localhost:5173`
   * for local dev). Must be an exact origin, never `'*'`. */
  aurapixOrigin?: string;
  /** Optional override of the embed URL. Defaults to
   * `${aurapixOrigin}/embed`. Useful for in-product staging routes. */
  embedUrl?: string;
  /** Max time to wait for the `aurapix:ready` handshake before firing
   * `onError`. Defaults to {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}. */
  handshakeTimeoutMs?: number;
  /** Fired exactly once on successful handshake. */
  onReady?: (detail: AuraPixReadyDetail) => void;
  /** Fired for every typed error (handshake timeout, invalid options, …). */
  onError?: (err: AuraPixError) => void;
  /** Catch-all for forwarded UI events (`aurapix:event` messages). */
  onEvent?: (evt: { name: string; payload?: unknown }) => void;
  /** Optional sandbox attribute applied to the iframe. Default value
   * grants the typical embed feature set; pass `null` to omit. */
  sandbox?: string | null;
  /** Optional `allow` attribute (Permissions Policy). Default is `''`. */
  allow?: string;
  /** Test seam: override the global `window`. */
  window?: Window;
  /** Test seam: override the global `document`. */
  document?: Document;
  /** Test seam: override `fetch` used for session-end beacons. */
  fetch?: typeof fetch;
}

export interface AuraPixHandle {
  /** The iframe element the SDK created and inserted. */
  readonly iframe: HTMLIFrameElement;
  /** Navigate the embed to a specific photo. */
  openPhoto(photoId: string): void;
  /** Navigate the embed to a specific album. */
  openAlbum(albumId: string): void;
  /** Update the embed's theme without remount. */
  setTheme(theme: AuraPixTheme): void;
  /** Subscribe to forwarded `aurapix:event` events.
   *
   * Special channels: `'ready'` (fires after handshake), `'error'`
   * (fires with {@link AuraPixError}), `'resize'` (fires with `{ height }`).
   *
   * @returns unsubscribe function */
  on<P = unknown>(event: AuraPixEventName, handler: AuraPixEventHandler<P>): () => void;
  /** Tear down: detach listeners, fire `embed.session_ended` beacon,
   * remove the iframe. Idempotent. */
  destroy(): void;
}

const AURAPIX_MESSAGE_PREFIX = 'aurapix:';
const DEFAULT_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads';
const INVALID_OPTIONS = 'invalid_options';
const INVALID_ORIGIN = 'invalid_origin';
const INVALID_ELEMENT = 'invalid_element';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function err(code: AuraPixErrorCode, message: string): AuraPixError {
  return new AuraPixError(code, message);
}

function parseOrigin(value: string): string {
  if (!value || value === '*') throw err(INVALID_ORIGIN, value);
  let parsed: string;
  try {
    parsed = new URL(value).origin;
  } catch {
    throw err(INVALID_ORIGIN, value);
  }
  if (parsed === 'null') throw err(INVALID_ORIGIN, 'null');
  return parsed;
}

function fireAll<T>(set: Set<(p: T) => void>, payload: T): void {
  for (const l of set) {
    try {
      l(payload);
    } catch {
      /* listener errors must not break dispatch */
    }
  }
}

/**
 * Mount AuraPix into the given host element. Creates an iframe, performs
 * the {@link https://github.com/rwrife/AuraPix/issues/163 `aurapix:ready`}
 * handshake, validates the response origin, and returns a handle for the
 * imperative API.
 */
export function mountAuraPix(
  hostElement: HTMLElement,
  opts: MountAuraPixOptions
): AuraPixHandle {
  if (!opts || typeof opts !== 'object') throw err(INVALID_OPTIONS, 'options');
  if (typeof opts.tenantId !== 'string' || !opts.tenantId) {
    throw err(INVALID_OPTIONS, 'tenantId');
  }
  if (typeof opts.userJwt !== 'string' || !opts.userJwt) {
    throw err(INVALID_OPTIONS, 'userJwt');
  }
  if (
    opts.handshakeTimeoutMs !== undefined &&
    !((opts.handshakeTimeoutMs as number) > 0)
  ) {
    throw err(INVALID_OPTIONS, 'handshakeTimeoutMs must be > 0');
  }
  if (!hostElement || typeof hostElement !== 'object' || !('appendChild' in hostElement)) {
    throw err(INVALID_ELEMENT, 'host element');
  }

  const win = opts.window ?? globalThis.window;
  const doc = opts.document ?? globalThis.document;
  if (!win || typeof win.addEventListener !== 'function') {
    throw err(INVALID_ELEMENT, 'window');
  }
  if (!doc || typeof doc.createElement !== 'function') {
    throw err(INVALID_ELEMENT, 'document');
  }

  const aurapixOrigin = parseOrigin(opts.aurapixOrigin ?? DEFAULT_AURAPIX_ORIGIN);
  const base = opts.embedUrl ?? `${aurapixOrigin}/embed`;
  const url = new URL(base, aurapixOrigin);
  url.searchParams.set('tenantId', opts.tenantId);
  if (opts.libraryId) url.searchParams.set('libraryId', opts.libraryId);
  if (opts.theme) url.searchParams.set('theme', opts.theme);
  url.searchParams.set('sdk', SDK_VERSION);
  // JWT in the fragment so it never reaches server logs / Referer headers.
  url.hash = `jwt=${encodeURIComponent(opts.userJwt)}`;

  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const fetchImpl = opts.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

  const iframe = doc.createElement('iframe') as HTMLIFrameElement;
  iframe.src = url.toString();
  iframe.title = 'AuraPix';
  iframe.style.cssText = 'border:0;width:100%;height:100%';
  if (opts.sandbox !== null) iframe.setAttribute('sandbox', opts.sandbox ?? DEFAULT_SANDBOX);
  if (opts.allow !== undefined) iframe.setAttribute('allow', opts.allow);
  hostElement.appendChild(iframe);

  const readyListeners = new Set<(d: AuraPixReadyDetail) => void>();
  const errorListeners = new Set<(e: AuraPixError) => void>();
  const resizeListeners = new Set<(p: { height: number }) => void>();
  const eventListeners = new Map<string, Set<AuraPixEventHandler>>();

  if (opts.onReady) readyListeners.add(opts.onReady);
  if (opts.onError) errorListeners.add(opts.onError);
  const userCatchAll = opts.onEvent;

  let destroyed = false;
  let readyFired = false;
  let sessionStartedAt: number | null = null;
  const sessionId = `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const sendInbound = (msg: { type: string; [k: string]: unknown }): void => {
    if (destroyed) return;
    const target = iframe.contentWindow;
    if (target) {
      try {
        target.postMessage(msg, aurapixOrigin);
      } catch {
        /* cross-origin postMessage may throw before navigation */
      }
    }
  };

  const handshakeTimer = win.setTimeout(() => {
    if (readyFired || destroyed) return;
    fireAll(errorListeners, err('handshake_timeout', `${handshakeTimeoutMs}ms`));
  }, handshakeTimeoutMs);

  const onMessage = (event: MessageEvent): void => {
    if (destroyed) return;
    // Origin gate — prevents iframe-busting / spoofing per issue #177.
    if (event.origin !== aurapixOrigin) return;
    if (event.source !== iframe.contentWindow) return;
    const data: unknown = event.data;
    if (!isPlainObject(data)) return;
    const t = data.type;
    if (typeof t !== 'string' || !t.startsWith(AURAPIX_MESSAGE_PREFIX)) return;

    if (
      t === 'aurapix:ready' &&
      typeof data.tenantId === 'string' &&
      typeof data.version === 'string'
    ) {
      if (readyFired) return;
      readyFired = true;
      win.clearTimeout(handshakeTimer);
      sessionStartedAt = Date.now();
      if (data.tenantId !== opts.tenantId) {
        fireAll(
          errorListeners,
          err(INVALID_OPTIONS, `tenantId mismatch: expected "${opts.tenantId}", got "${data.tenantId}"`)
        );
        return;
      }
      // Issue #187: optional, public-safe branding tokens. The embedded
      // app vets the payload server-side; we still drop non-string
      // fields here so a compromised iframe can't slip values of the
      // wrong type into the host's CSS.
      let branding: AuraPixBrandingTokens | undefined;
      const b = data.branding;
      if (isPlainObject(b)) {
        const out: Record<string, string> = {};
        for (const k in b) {
          const v = (b as Record<string, unknown>)[k];
          if (typeof v === 'string' && v) out[k] = v;
        }
        for (const _ in out) { branding = out; break; }
      }
      const detail: AuraPixReadyDetail = {
        tenantId: data.tenantId,
        version: data.version,
        origin: aurapixOrigin,
        ...(branding ? { branding } : {}),
      };
      fireAll(readyListeners, detail);
      return;
    }

    if (
      t === 'aurapix:resize' &&
      typeof data.height === 'number' &&
      Number.isFinite(data.height) &&
      data.height >= 0
    ) {
      fireAll(resizeListeners, { height: data.height });
      return;
    }

    if (t === 'aurapix:event' && typeof data.name === 'string') {
      const evt = { name: data.name, payload: data.payload };
      if (userCatchAll) {
        try {
          userCatchAll(evt);
        } catch {
          /* swallow */
        }
      }
      const handlers = eventListeners.get(data.name);
      if (handlers) fireAll(handlers, data.payload);
      return;
    }
  };

  win.addEventListener('message', onMessage);

  // Best-effort `embed.session_ended` beacon. Fires on `destroy()` AND on
  // `pagehide` (iframe unload heartbeat). The SDK never embeds an API
  // key; the backend authenticates the session via the tenantId +
  // sessionId pair it already issued an `embed.session_started` for.
  const sendSessionEnd = (): void => {
    if (!sessionStartedAt || !fetchImpl) return;
    const body = JSON.stringify({
      tenantId: opts.tenantId,
      sessionId,
      durationMs: Date.now() - sessionStartedAt,
      sdkVersion: SDK_VERSION,
    });
    const u = `${aurapixOrigin}/v1/tenants/${encodeURIComponent(opts.tenantId)}/embed/session-end`;
    try {
      const nav = (win as unknown as { navigator?: Navigator }).navigator;
      if (nav && typeof nav.sendBeacon === 'function') {
        try {
          nav.sendBeacon(u, new Blob([body], { type: 'application/json' }));
          return;
        } catch {
          /* fall through */
        }
      }
      void fetchImpl(u, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        credentials: 'omit',
        mode: 'no-cors',
      }).catch(() => {
        /* best-effort */
      });
    } catch {
      /* swallow */
    }
  };

  const onPageHide = (): void => sendSessionEnd();
  win.addEventListener('pagehide', onPageHide);

  return {
    iframe,
    openPhoto(photoId: string): void {
      if (typeof photoId !== 'string' || !photoId) throw err(INVALID_OPTIONS, 'photoId');
      sendInbound({ type: 'aurapix:navigate', path: `/photos/${encodeURIComponent(photoId)}` });
    },
    openAlbum(albumId: string): void {
      if (typeof albumId !== 'string' || !albumId) throw err(INVALID_OPTIONS, 'albumId');
      sendInbound({ type: 'aurapix:navigate', path: `/albums/${encodeURIComponent(albumId)}` });
    },
    setTheme(theme: AuraPixTheme): void {
      if (typeof theme !== 'string' || !theme) throw err(INVALID_OPTIONS, 'theme');
      sendInbound({ type: 'aurapix:set-theme', theme });
    },
    on<P>(event: AuraPixEventName, handler: AuraPixEventHandler<P>): () => void {
      if (typeof event !== 'string' || !event) throw err(INVALID_OPTIONS, 'event');
      if (typeof handler !== 'function') throw err(INVALID_OPTIONS, 'handler');
      if (event === 'ready') {
        readyListeners.add(handler as unknown as (d: AuraPixReadyDetail) => void);
        return () => readyListeners.delete(handler as unknown as (d: AuraPixReadyDetail) => void);
      }
      if (event === 'error') {
        errorListeners.add(handler as unknown as (e: AuraPixError) => void);
        return () => errorListeners.delete(handler as unknown as (e: AuraPixError) => void);
      }
      if (event === 'resize') {
        resizeListeners.add(handler as unknown as (p: { height: number }) => void);
        return () =>
          resizeListeners.delete(handler as unknown as (p: { height: number }) => void);
      }
      let set = eventListeners.get(event);
      if (!set) {
        set = new Set();
        eventListeners.set(event, set);
      }
      set.add(handler as AuraPixEventHandler);
      return () => {
        const s = eventListeners.get(event);
        if (!s) return;
        s.delete(handler as AuraPixEventHandler);
        if (s.size === 0) eventListeners.delete(event);
      };
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      win.clearTimeout(handshakeTimer);
      win.removeEventListener('message', onMessage);
      win.removeEventListener('pagehide', onPageHide);
      sendSessionEnd();
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      readyListeners.clear();
      errorListeners.clear();
      resizeListeners.clear();
      eventListeners.clear();
    },
  };
}
