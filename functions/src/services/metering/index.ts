import { signingConfig } from '../../config/index.js';
import { HostWebhookSink } from './HostWebhookSink.js';
import {
  InMemoryWebhookDeliveryStore,
  type WebhookDeliveryStore,
} from './WebhookDeliveryStore.js';
import {
  MeteringBus,
  NoopMeteringSink,
  type MeteringEvent,
  type MeteringSink,
} from './MeteringBus.js';

/**
 * Resolve a tenant identifier for a metering event.
 *
 * AuraPix does not yet have a first-class tenantId on every request
 * (see the tenant-id issue tracked separately). Until that lands,
 * fall back to a stable, library-derived identifier so host-side
 * partitioning still works.
 */
export function resolveTenantId(opts: {
  tenantId?: string | null;
  libraryId?: string | null;
}): string {
  const explicit = opts.tenantId?.trim();
  if (explicit) {
    return explicit;
  }
  const lib = opts.libraryId?.trim();
  if (lib) {
    return `lib:${lib}`;
  }
  return 'lib:unknown';
}

let busInstance: MeteringBus | null = null;
let sinkInstance: HostWebhookSink | null = null;
let deliveryStoreInstance: WebhookDeliveryStore | null = null;

/**
 * Process-wide delivery store used by the host webhook sink. Records are
 * scoped to `tenants/{tenantId}/webhookDeliveries/{batchId}` and surfaced
 * through the `/v1/tenants/:id/webhooks/deliveries*` routes (issue #144).
 */
export function getWebhookDeliveryStore(): WebhookDeliveryStore {
  if (!deliveryStoreInstance) {
    deliveryStoreInstance = new InMemoryWebhookDeliveryStore();
  }
  return deliveryStoreInstance;
}

export function setWebhookDeliveryStore(store: WebhookDeliveryStore | null): void {
  deliveryStoreInstance = store;
  // Force the sink to be rebuilt next time getHostWebhookSink() is called.
  sinkInstance = null;
  busInstance = null;
}

function buildSink(): MeteringSink {
  const webhookUrl = process.env.HOST_METERING_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return new NoopMeteringSink();
  }
  sinkInstance = new HostWebhookSink({
    webhookUrl,
    signingSecret: signingConfig.masterSecret,
    deliveryStore: getWebhookDeliveryStore(),
  });
  return sinkInstance;
}

/**
 * Returns the host webhook sink instance (or null when metering is
 * disabled / no webhook URL is configured). Exposed so the replay route
 * (issue #144) can reuse the in-process batch cache.
 */
export function getHostWebhookSink(): HostWebhookSink | null {
  // Ensure the bus has been initialized so sinkInstance is populated.
  getMeteringBus();
  return sinkInstance;
}

/**
 * Get (or lazily create) the process-wide metering bus.
 */
export function getMeteringBus(): MeteringBus {
  if (!busInstance) {
    busInstance = new MeteringBus({ sink: buildSink() });
  }
  return busInstance;
}

/**
 * Override the bus (useful for tests and for wiring a custom sink at
 * server bootstrap). Replaces any previous instance.
 */
export function setMeteringBus(bus: MeteringBus | null): void {
  busInstance = bus;
}

/**
 * Convenience: emit a single event onto the shared bus. Never throws.
 */
export function emitMeteringEvent(event: MeteringEvent): void {
  try {
    getMeteringBus().emit(event);
  } catch {
    // Bus.emit is already no-throw; this is belt-and-suspenders.
  }
}
