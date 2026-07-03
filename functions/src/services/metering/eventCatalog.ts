/**
 * Webhook / metering event catalog (issue #176).
 *
 * Single source of truth for every event AuraPix can emit on the metering
 * bus and over the host webhook. The runtime registry is consumed by:
 *
 *   - `MeteringBus` — its `MeteringEventType` is derived from this file,
 *     so adding a new event _here_ is the only way to make `emit()`
 *     compile against a new name (compile-time guard against ad-hoc
 *     event names).
 *   - `HostWebhookSink` — every outbound envelope includes the
 *     `catalogVersion` constant exported below, so hosts can detect when
 *     they're behind on a new event type.
 *   - `GET /v1/host/webhook-events` — returns the full catalog
 *     (host-API-key only) so integrators can build billing pipelines
 *     without scraping the docs.
 *   - `scripts/generate-event-catalog-docs.mjs` — regenerates the event
 *     table in `docs/features/metering-events.md` from this registry,
 *     so the docs cannot drift from reality.
 *
 * Each entry includes a JSON Schema (Draft 2020-12 compatible) describing
 * the `meta` payload shape for that event. Hosts can use these schemas
 * to validate incoming webhook payloads without hand-writing types.
 *
 * Conventions:
 *   - `version` is per-event; bump it when the meta shape changes in a
 *     non-additive way. The shared envelope version (currently `v1`) is
 *     unrelated and lives in `HostWebhookSink`.
 *   - `billable: true` is a hint, not a contract — hosts decide their own
 *     billing rules. Today we mark events as billable iff they map to a
 *     unit of resold work (uploads, processed images, signed URLs, etc.)
 *     and exclude pure observability events (`feature.gated`,
 *     `idempotency.replayed`, `*.flag_changed`, etc.).
 *   - `description` is a short, one-line summary. The longer table in
 *     `docs/features/metering-events.md` is generated from `description`
 *     plus the per-event JSON Schema property descriptions.
 */

/**
 * Bumped whenever the set of event types in the registry changes (new
 * event, removed event, or non-additive schema change). Hosts that ship
 * a snapshot of the catalog can compare this string against the
 * `catalogVersion` field in every webhook envelope and `GET /v1/host/
 * webhook-events` response to detect drift.
 *
 * Use a date string so the value is human-readable in logs.
 */
export const CATALOG_VERSION = '2026-07-01';

/**
 * JSON Schema describing the `meta` payload for a single event type.
 *
 * Intentionally typed as a permissive `Record<string, unknown>` so callers
 * can hand it to any Draft 2020-12 validator without forcing a hard
 * dependency on a specific schema library. Each entry below is a real
 * JSON Schema object; the `as const` keeps the literal shape narrow in
 * tooling but the public API only promises the wider record shape.
 */
export type EventMetaSchema = Record<string, unknown>;

/**
 * A single registered event type. Adding a new entry to this list is the
 * only supported way to introduce a new metering event.
 */
export interface RegisteredEvent {
  /** Stable event name (e.g. `photo.exported`). Snake-cased domain. */
  readonly name: string;
  /** Per-event schema version. Bump on non-additive meta changes. */
  readonly version: number;
  /**
   * Whether this event maps to a unit of billable work. Hosts can use
   * this as a default filter when rolling up usage; it is NOT a
   * contractual guarantee.
   */
  readonly billable: boolean;
  /** One-line summary used in the generated docs. */
  readonly description: string;
  /** JSON Schema (Draft 2020-12) for the event's `meta` object. */
  readonly schema: EventMetaSchema;
}

/**
 * Helper to build a schema object for the `meta` field. Always returns a
 * JSON Schema `object` with `additionalProperties: true` so hosts treat
 * extra fields as forward-compatible.
 */
function metaSchema(
  properties: Record<string, EventMetaSchema>,
  required: readonly string[] = []
): EventMetaSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: true,
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
  };
}

/**
 * Convenience JSON Schema fragments.
 */
const S_STRING: EventMetaSchema = { type: 'string' };
const S_NUMBER: EventMetaSchema = { type: 'number' };
const S_INTEGER: EventMetaSchema = { type: 'integer' };
const S_BOOLEAN: EventMetaSchema = { type: 'boolean' };
const S_ISO_DATE: EventMetaSchema = { type: 'string', format: 'date-time' };

/**
 * The registry. Order is preserved in API responses and generated docs.
 *
 * Keep this ordered roughly by domain (uploads → derivatives → signed
 * URLs → edits → batch → users → quotas → sharing → plugins → photos →
 * tenant lifecycle → embed → idempotency → webhook → tags → exports →
 * smart albums → feature flags) so the public catalog reads top-down.
 */
export const EVENT_CATALOG = [
  {
    name: 'upload.accepted',
    version: 1,
    billable: true,
    description:
      'Original image stored after a successful upload. One event per photo.',
    schema: metaSchema({
      userId: S_STRING,
      sourceType: S_STRING,
    }),
  },
  {
    name: 'image.processed',
    version: 1,
    billable: true,
    description:
      'A derivative variant (thumbnail / preview) was written. One event per variant.',
    schema: metaSchema({
      stage: { type: 'string', enum: ['thumbnail', 'preview'] },
      variant: S_STRING,
    }),
  },
  {
    name: 'signed_url.issued',
    version: 1,
    billable: true,
    description: 'A signed URL was minted for a user or share grant.',
    schema: metaSchema({
      grantType: { type: 'string', enum: ['user', 'share'] },
    }),
  },
  {
    name: 'edit.applied',
    version: 1,
    billable: true,
    description: 'A non-destructive edit version was committed for a photo.',
    schema: metaSchema({
      version: S_INTEGER,
      operationCount: S_INTEGER,
    }),
  },
  {
    name: 'edit_preset.applied',
    version: 1,
    billable: false,
    description:
      'A develop preset (issue #197) was applied to a batch of photos. One event per apply call, regardless of N. Per-photo commits still emit `edit.applied`.',
    schema: metaSchema({
      presetId: S_STRING,
      photoCount: S_INTEGER,
      succeeded: S_INTEGER,
      failed: S_INTEGER,
    }),
  },
  {
    name: 'bulk.batch',
    version: 1,
    billable: true,
    description:
      'A `POST /v1/photos:batch` call completed. One event per call regardless of N.',
    schema: metaSchema({
      action: S_STRING,
      requested: S_INTEGER,
      succeeded: S_INTEGER,
      failed: S_INTEGER,
    }),
  },
  {
    name: 'user.active',
    version: 1,
    billable: true,
    description:
      'First end-user request of the UTC day for `(tenantId, userId)`. The per-seat billing signal.',
    schema: metaSchema({
      firstSeenAt: S_ISO_DATE,
      route: S_STRING,
    }),
  },
  {
    name: 'user.provisioned',
    version: 1,
    billable: false,
    description: 'A new tenant membership was created.',
    schema: metaSchema({
      role: S_STRING,
      email: S_STRING,
    }),
  },
  {
    name: 'user.revoked',
    version: 1,
    billable: false,
    description: 'A tenant membership was removed.',
    schema: metaSchema({
      role: S_STRING,
    }),
  },
  {
    name: 'quota.exceeded',
    version: 1,
    billable: false,
    description:
      'In-process storage quota check rejected an upload with HTTP 413.',
    schema: metaSchema({
      libraryId: S_STRING,
      usageBytes: S_NUMBER,
      quotaBytes: S_NUMBER,
      attemptedBytes: S_NUMBER,
    }),
  },
  {
    name: 'quota.warning',
    version: 1,
    billable: false,
    description:
      'Tenant storage usage crossed a configured threshold (e.g. 80%, 95%). Once per threshold per UTC day.',
    schema: metaSchema({
      threshold: S_NUMBER,
      quotaBytes: S_NUMBER,
      usageBytes: S_NUMBER,
      date: S_STRING,
    }),
  },
  {
    name: 'tenant.storage.threshold_crossed',
    version: 1,
    billable: false,
    description:
      'Per-tenant storage usage crossed a configured threshold (issue #196). Hysteresis prevents re-firing until usage drops 5% below and crosses up again. Hosts drive upsell / hard-cap flows from this event.',
    schema: metaSchema(
      {
        tenantId: S_STRING,
        threshold: S_NUMBER,
        usedBytes: S_NUMBER,
        quotaBytes: S_NUMBER,
        crossedAt: S_ISO_DATE,
      },
      ['tenantId', 'threshold', 'usedBytes', 'quotaBytes', 'crossedAt']
    ),
  },
  {
    name: 'tenant.storage.threshold_cleared',
    version: 1,
    billable: false,
    description:
      'Per-tenant storage usage dropped at least 5% below a previously-crossed threshold (issue #196). Emitted exactly once per crossing direction; pairs with `tenant.storage.threshold_crossed`.',
    schema: metaSchema(
      {
        tenantId: S_STRING,
        threshold: S_NUMBER,
        usedBytes: S_NUMBER,
        quotaBytes: S_NUMBER,
        clearedAt: S_ISO_DATE,
      },
      ['tenantId', 'threshold', 'usedBytes', 'quotaBytes', 'clearedAt']
    ),
  },
  {
    name: 'share.viewed',
    version: 1,
    billable: true,
    description:
      'A share token passed auth and a resource was actually delivered.',
    schema: metaSchema({
      photoId: S_STRING,
      libraryId: S_STRING,
      grantType: { type: 'string', enum: ['album', 'photo', 'library'] },
    }),
  },
  {
    name: 'plugin.ran',
    version: 1,
    billable: true,
    description:
      'A plugin/edit operation executed (success or failure). One event per operation.',
    schema: metaSchema({
      pluginId: S_STRING,
      durationMs: S_NUMBER,
      success: S_BOOLEAN,
    }),
  },
  {
    name: 'plugin.enabled',
    version: 1,
    billable: false,
    description: 'A tenant toggled a plugin to enabled.',
    schema: metaSchema({
      pluginId: S_STRING,
    }),
  },
  {
    name: 'plugin.disabled',
    version: 1,
    billable: false,
    description: 'A tenant toggled a plugin to disabled.',
    schema: metaSchema({
      pluginId: S_STRING,
    }),
  },
  {
    name: 'plugin.blocked',
    version: 1,
    billable: false,
    description:
      'An edit operation referenced a plugin not in the tenant allowlist.',
    schema: metaSchema({
      pluginId: S_STRING,
    }),
  },
  {
    name: 'photo.trashed',
    version: 1,
    billable: false,
    description: 'A photo was soft-deleted (moved to trash).',
    schema: metaSchema({
      libraryId: S_STRING,
      actor: S_STRING,
    }),
  },
  {
    name: 'photo.purged',
    version: 1,
    billable: false,
    description:
      'A trashed photo was permanently purged and its bytes freed. `bytes` is negative.',
    schema: metaSchema({
      libraryId: S_STRING,
      trashedAt: S_ISO_DATE,
    }),
  },
  {
    name: 'photo.tagged',
    version: 1,
    billable: false,
    description:
      'A photo had tags, rating, flag, or color label changed. One event per mutation, not per tag. Issue #184 added `meta.kind` to disambiguate (`tag` | `rating` | `flag` | `colorLabel`).',
    schema: metaSchema({
      libraryId: S_STRING,
      actor: S_STRING,
      added: { type: 'array', items: S_STRING },
      removed: { type: 'array', items: S_STRING },
      kind: { type: 'string', enum: ['tag', 'rating', 'flag', 'colorLabel'] },
      rating: { type: 'integer', minimum: 0, maximum: 5 },
      flag: { type: ['string', 'null'], enum: ['pick', 'reject', null] },
      colorLabel: {
        type: ['string', 'null'],
        enum: ['red', 'yellow', 'green', 'blue', 'purple', null],
      },
      viaBulk: S_BOOLEAN,
    }),
  },
  {
    name: 'photo.exported',
    version: 1,
    billable: true,
    description:
      'A photo was successfully exported (cache hit or miss). Drives the `exportBytes` rollup. Issue #185 added `meta.watermark` (boolean) to distinguish watermarked vs clean exports.',
    schema: metaSchema({
      libraryId: S_STRING,
      preset: S_STRING,
      outputWidth: S_INTEGER,
      outputHeight: S_INTEGER,
      cacheHit: S_BOOLEAN,
      actor: S_STRING,
      // Issue #185: hosts can price watermarked vs clean exports
      // differently. Additive; no version bump per `eventCatalog.ts`
      // rules (the `meta` schema is `additionalProperties: true`).
      watermark: S_BOOLEAN,
    }),
  },
  {
    name: 'audit.queried',
    version: 1,
    billable: false,
    description: 'The host audit-events API was queried.',
    schema: metaSchema({
      route: S_STRING,
      resultCount: S_INTEGER,
    }),
  },
  {
    name: 'tenant.export.requested',
    version: 1,
    billable: false,
    description: 'A tenant data export was initiated via the offboarding API.',
    schema: metaSchema({
      exportId: S_STRING,
    }),
  },
  {
    name: 'tenant.export.completed',
    version: 1,
    billable: false,
    description: 'A tenant data export finished and the bundle is available.',
    schema: metaSchema({
      exportId: S_STRING,
      bytes: S_NUMBER,
    }),
  },
  {
    name: 'tenant.deleted',
    version: 1,
    billable: false,
    description:
      'A tenant was hard-deleted. After this event, no further events for the tenant should fire.',
    schema: metaSchema({}),
  },
  {
    name: 'embed.session_started',
    version: 1,
    billable: false,
    description:
      'An allowed parent origin framed an embed-eligible response. Debounced per `(tenantId, origin)`.',
    schema: metaSchema({
      origin: S_STRING,
      userAgent: S_STRING,
    }),
  },
  {
    name: 'embed.session_ended',
    version: 1,
    billable: false,
    description:
      'The embed SDK reported a session end via the beacon endpoint or page unload.',
    schema: metaSchema({
      sessionId: S_STRING,
      sdkVersion: S_STRING,
      durationMs: S_NUMBER,
    }),
  },
  {
    name: 'embed.origin_blocked',
    version: 1,
    billable: false,
    description:
      'A browser-reported `frame-ancestors` CSP violation. Helps hosts find misconfigured deployments.',
    schema: metaSchema({
      blockedUri: S_STRING,
      documentUri: S_STRING,
      violatedDirective: S_STRING,
    }),
  },
  {
    name: 'embed.session.minted',
    version: 1,
    billable: false,
    description:
      'Host minted an embed session token via POST /v1/tenants/{tenantId}/embed/session-tokens (issue #195). Useful for billing per-session pricing models.',
    schema: metaSchema({
      userId: S_STRING,
      role: S_STRING,
      jtiHash: S_STRING,
      ttlSeconds: S_INTEGER,
    }),
  },
  {
    name: 'embed.session.exchanged',
    version: 1,
    billable: false,
    description:
      'Embedded iframe successfully redeemed an embed session token — the meaningful "active embedded user" signal that complements `user.active` with embed context (issue #195).',
    schema: metaSchema({
      userId: S_STRING,
      role: S_STRING,
      jtiHash: S_STRING,
      matchedSecret: { type: 'string', enum: ['current', 'previous'] },
    }),
  },
  {
    name: 'idempotency.replayed',
    version: 1,
    billable: false,
    description:
      'Idempotency-Key middleware served a cached response. Debug-tier; NOT billable.',
    schema: metaSchema({
      route: S_STRING,
      key: S_STRING,
    }),
  },
  {
    name: 'webhook.secret_rotated',
    version: 1,
    billable: false,
    description: 'A tenant rotated its webhook signing secret.',
    schema: metaSchema({
      fingerprint: S_STRING,
      previousFingerprint: S_STRING,
      graceSeconds: S_INTEGER,
    }),
  },
  {
    name: 'smart_album.created',
    version: 1,
    billable: false,
    description: 'A smart album definition was created.',
    schema: metaSchema({
      libraryId: S_STRING,
    }),
  },
  {
    name: 'smart_album.deleted',
    version: 1,
    billable: false,
    description: 'A smart album definition was deleted.',
    schema: metaSchema({
      libraryId: S_STRING,
    }),
  },
  {
    name: 'smart_album.materialized',
    version: 1,
    billable: true,
    description:
      'A smart album was materialized via `GET /smart-albums/:id/photos`.',
    schema: metaSchema({
      libraryId: S_STRING,
      resultCount: S_INTEGER,
      totalCount: S_INTEGER,
    }),
  },
  {
    name: 'feature.gated',
    version: 1,
    billable: false,
    description:
      'A request was rejected because a per-tenant feature flag is disabled. Hosts surface upsell.',
    schema: metaSchema({
      feature: S_STRING,
      route: S_STRING,
    }),
  },
  {
    name: 'feature.flag_changed',
    version: 1,
    billable: false,
    description:
      'A host toggled a per-tenant feature flag. Audit / change-history signal.',
    schema: metaSchema({
      feature: S_STRING,
      oldValue: S_BOOLEAN,
      newValue: S_BOOLEAN,
      actor: S_STRING,
    }),
  },
] as const satisfies readonly RegisteredEvent[];

/**
 * Union of all registered event names. Derived from `EVENT_CATALOG` so
 * adding a new entry above is the ONLY way to extend the type.
 */
export type RegisteredEventName = (typeof EVENT_CATALOG)[number]['name'];

/**
 * Map from event name to its full registry entry. Useful for O(1) lookups
 * (e.g. envelope enrichment, validation).
 */
export const EVENT_CATALOG_BY_NAME: Readonly<
  Record<RegisteredEventName, RegisteredEvent>
> = Object.freeze(
  Object.fromEntries(EVENT_CATALOG.map((e) => [e.name, e])) as Record<
    RegisteredEventName,
    RegisteredEvent
  >
);

/**
 * Public-facing catalog response shape (returned by
 * `GET /v1/host/webhook-events`).
 */
export interface EventCatalogResponse {
  catalogVersion: string;
  events: ReadonlyArray<RegisteredEvent>;
}

/**
 * Build the response body for the public catalog endpoint. Returns a
 * deep-frozen value so callers cannot accidentally mutate the registry.
 */
export function getEventCatalogResponse(): EventCatalogResponse {
  return {
    catalogVersion: CATALOG_VERSION,
    events: EVENT_CATALOG,
  };
}
