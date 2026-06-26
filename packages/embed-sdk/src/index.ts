/**
 * @aurapix/embed — drop-in iframe loader + postMessage client.
 *
 * The SDK is strictly client-side. The host's backend mints the user JWT
 * (server-to-server); the SDK never sees the host's API key. The SDK
 * refuses messages from any origin other than the configured AuraPix
 * origin to prevent iframe-busting and spoofing.
 *
 * Tracking issue: https://github.com/rwrife/AuraPix/issues/177
 */
export {
  mountAuraPix,
  DEFAULT_AURAPIX_ORIGIN,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  SDK_VERSION,
  AuraPixError,
} from './mount.js';
export type {
  MountAuraPixOptions,
  AuraPixHandle,
  AuraPixEventHandler,
  AuraPixErrorCode,
  AuraPixTheme,
  AuraPixReadyDetail,
  AuraPixEventName,
  AuraPixBrandingTokens,
} from './mount.js';
