/**
 * AuraPix Embed handshake — shared message contract.
 *
 * Both the host (`src/embed/host-sdk.ts`) and the embedded AuraPix UI
 * (`src/embed/embedded.ts`) import these types and guards so the protocol
 * has exactly one source of truth. See `docs/features/embed-handshake.md`
 * for the full specification.
 */

/** Sent by the embedded UI as soon as it mounts. */
export interface AuraPixReadyMessage {
  type: 'aurapix:ready';
  tenantId: string;
  /** SemVer string of the embedded build. */
  version: string;
}

/** Sent by the embedded UI when its content height changes. */
export interface AuraPixResizeMessage {
  type: 'aurapix:resize';
  /** CSS pixel height of the embedded content. */
  height: number;
}

/** Generic user-action event emitted by the embedded UI. */
export interface AuraPixEventMessage {
  type: 'aurapix:event';
  /** Event name (`selection-changed`, `upload-started`, ...). */
  name: string;
  payload?: unknown;
}

/** Host → embedded: switch theme. */
export interface AuraPixSetThemeMessage {
  type: 'aurapix:set-theme';
  theme: 'light' | 'dark' | 'system' | (string & {});
}

/** Host → embedded: navigate to a route inside AuraPix. */
export interface AuraPixNavigateMessage {
  type: 'aurapix:navigate';
  /** Path starting with `/`. */
  path: string;
}

/**
 * Host → embedded: forward a host-issued embed session token (issue #195).
 *
 * Sent by the host SDK as the first `postMessage` after the embedded UI
 * announces `aurapix:ready`. The embedded UI POSTs the token to
 * `/v1/tenants/{tenantId}/embed/session-exchange` to mint a server-side
 * session without showing the Firebase login UI.
 */
export interface AuraPixSessionMessage {
  type: 'aurapix:session';
  /**
   * Compact JWT minted by the host backend via
   * `POST /v1/tenants/{tenantId}/embed/session-tokens`. Single use,
   * short-lived (TTL ≤ 300s), bound to a specific tenant.
   */
  token: string;
}

export type AuraPixOutboundMessage =
  | AuraPixReadyMessage
  | AuraPixResizeMessage
  | AuraPixEventMessage;

export type AuraPixInboundMessage =
  | AuraPixSetThemeMessage
  | AuraPixNavigateMessage
  | AuraPixSessionMessage;

export type AuraPixMessage = AuraPixOutboundMessage | AuraPixInboundMessage;

export const AURAPIX_MESSAGE_PREFIX = 'aurapix:' as const;

export const AURAPIX_MESSAGE_TYPES = {
  ready: 'aurapix:ready',
  resize: 'aurapix:resize',
  event: 'aurapix:event',
  setTheme: 'aurapix:set-theme',
  navigate: 'aurapix:navigate',
  session: 'aurapix:session',
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` looks like any AuraPix postMessage payload. */
export function isAuraPixMessage(value: unknown): value is AuraPixMessage {
  if (!isPlainObject(value)) return false;
  const t = value.type;
  return typeof t === 'string' && t.startsWith(AURAPIX_MESSAGE_PREFIX);
}

export function isAuraPixReady(value: unknown): value is AuraPixReadyMessage {
  return (
    isPlainObject(value) &&
    value.type === AURAPIX_MESSAGE_TYPES.ready &&
    typeof value.tenantId === 'string' &&
    typeof value.version === 'string'
  );
}

export function isAuraPixResize(value: unknown): value is AuraPixResizeMessage {
  return (
    isPlainObject(value) &&
    value.type === AURAPIX_MESSAGE_TYPES.resize &&
    typeof value.height === 'number' &&
    Number.isFinite(value.height as number) &&
    (value.height as number) >= 0
  );
}

export function isAuraPixEvent(value: unknown): value is AuraPixEventMessage {
  return (
    isPlainObject(value) &&
    value.type === AURAPIX_MESSAGE_TYPES.event &&
    typeof value.name === 'string'
  );
}

export function isAuraPixSetTheme(
  value: unknown
): value is AuraPixSetThemeMessage {
  return (
    isPlainObject(value) &&
    value.type === AURAPIX_MESSAGE_TYPES.setTheme &&
    typeof value.theme === 'string'
  );
}

export function isAuraPixNavigate(
  value: unknown
): value is AuraPixNavigateMessage {
  return (
    isPlainObject(value) &&
    value.type === AURAPIX_MESSAGE_TYPES.navigate &&
    typeof value.path === 'string' &&
    value.path.startsWith('/')
  );
}

/**
 * Type guard for the host-issued embed session token forwarded over
 * postMessage (issue #195). Validates structure only — the token itself
 * is verified server-side at /v1/tenants/{tenantId}/embed/session-exchange.
 */
export function isAuraPixSession(
  value: unknown
): value is AuraPixSessionMessage {
  return (
    isPlainObject(value) &&
    value.type === AURAPIX_MESSAGE_TYPES.session &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    // Compact JWTs are header.payload.signature — reject obvious garbage
    // early so the embedded UI doesn't waste a network round-trip.
    value.token.split('.').length === 3
  );
}
