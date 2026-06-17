/**
 * AuraPix Embedded-side SDK — implements the AuraPix end of the
 * postMessage handshake. Used from within the AuraPix UI; matches the
 * host-side {@link import('./host-sdk.js').createEmbedHost}.
 */
import {
  AURAPIX_MESSAGE_TYPES,
  isAuraPixMessage,
  type AuraPixInboundMessage,
  type AuraPixOutboundMessage,
} from './contract.js';

export interface EmbeddedEmitterOptions {
  /** Tenant id — sent in the `aurapix:ready` message. */
  tenantId: string;
  /** Embedded build version (e.g. from `package.json`). */
  version: string;
  /** Allowed parent origins (exact match). Inbound messages from other
   * origins are dropped; outbound messages are posted once per allowed
   * origin. */
  allowedOrigins: readonly string[];
  /** `window` reference — defaults to global `window`. */
  window?: Window;
}

export interface EmbeddedHandle {
  ready(): void;
  resize(height: number): void;
  emit(name: string, payload?: unknown): void;
  on(
    handler: (msg: AuraPixInboundMessage, event: MessageEvent) => void
  ): () => void;
  dispose(): void;
}

export function createEmbedded(opts: EmbeddedEmitterOptions): EmbeddedHandle {
  const w = opts.window ?? globalThis.window;
  if (!w || typeof w.addEventListener !== 'function') {
    throw new Error('createEmbedded requires a browser window');
  }
  const allowed = new Set(
    opts.allowedOrigins
      .map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          return null;
        }
      })
      .filter((o): o is string => o !== null && o !== 'null')
  );

  type InboundHandler = (
    msg: AuraPixInboundMessage,
    event: MessageEvent
  ) => void;
  const listeners = new Set<InboundHandler>();
  let disposed = false;

  const postToParent = (msg: AuraPixOutboundMessage): void => {
    if (disposed) return;
    const parent = w.parent;
    if (!parent || parent === w) return;
    for (const origin of allowed) {
      try {
        parent.postMessage(msg, origin);
      } catch {
        // Cross-origin or targetOrigin mismatch — ignore and continue.
      }
    }
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    if (!allowed.has(event.origin)) return;
    if (event.source !== w.parent) return;
    if (!isAuraPixMessage(event.data)) return;
    const t = event.data.type;
    if (
      t !== AURAPIX_MESSAGE_TYPES.setTheme &&
      t !== AURAPIX_MESSAGE_TYPES.navigate
    ) {
      return;
    }
    for (const l of listeners) {
      try {
        l(event.data as AuraPixInboundMessage, event);
      } catch {
        // Listener errors must not break dispatch.
      }
    }
  };

  w.addEventListener('message', onMessage);

  return {
    ready() {
      postToParent({
        type: AURAPIX_MESSAGE_TYPES.ready,
        tenantId: opts.tenantId,
        version: opts.version,
      });
    },
    resize(height) {
      const safe = Math.max(0, Math.floor(height));
      postToParent({ type: AURAPIX_MESSAGE_TYPES.resize, height: safe });
    },
    emit(name, payload) {
      postToParent({ type: AURAPIX_MESSAGE_TYPES.event, name, payload });
    },
    on(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      w.removeEventListener('message', onMessage);
      listeners.clear();
    },
  };
}
