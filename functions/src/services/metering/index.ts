import { signingConfig } from '../../config/index.js';
import { HostWebhookSink } from './HostWebhookSink.js';
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

function buildSink(): MeteringSink {
  const webhookUrl = process.env.HOST_METERING_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return new NoopMeteringSink();
  }
  return new HostWebhookSink({
    webhookUrl,
    signingSecret: signingConfig.masterSecret,
  });
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
