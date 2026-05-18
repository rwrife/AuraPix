# ADR: First-class `tenantId` on libraries, albums, and photos

Status: Accepted
Date: 2025-05-18
Issue: rwrife/AuraPix#129

## Context

AuraPix is designed to be embedded inside host applications. Each host serves
many of its own customers, but until now the AuraPix data model only carried
`libraryId` and `userId`. Without a stable tenant key we cannot:

- scope rate limits, quotas, and usage rollups per host customer,
- give host apps a safe way to enumerate / delete a customer's data on
  offboarding,
- attribute storage, processed images, or plugin runs back to a billable
  entity,
- partition future metering events for billing.

## Decision

Introduce a first-class `tenantId: string` on the long-lived resources owned
by AuraPix: `Library`, `Album`, `Photo`, and the upload-session / idempotency
records. The field is the **primary partition key** for any future
multi-tenant feature (metering, quotas, host API keys, branding).

Resolution order for the request-scoped tenant id (implemented in
`functions/src/middleware/resolveTenant.ts`):

1. Host-issued API key claim on `req.user.tenantId` (future).
2. `X-AuraPix-Tenant-Id` header, only meaningful when the existing auth
   middleware has already authenticated the caller.
3. `DEFAULT_TENANT_ID = "default"` fallback for single-tenant deployments.

Server-side enforcement is the responsibility of the service layer via
`assertSameTenant(resource.tenantId, caller.tenantId)`, which throws
`CrossTenantAccessError` (HTTP 403). Existing rows without a `tenantId` are
treated as belonging to the default tenant so the rollout is non-breaking.

Storage paths optionally include the tenant id behind the
`TENANT_AWARE_STORAGE_PATHS` environment flag (default off). When enabled
the layout becomes:

```
originals/{tenantId}/{libraryId}/{photoId}/...
derivatives/{tenantId}/{libraryId}/{photoId}/...
```

A backfill script (`scripts/backfill-tenant-id.mjs`) idempotently stamps
existing Firestore documents with `tenantId = 'default'`.

## Tenant ID format

Tenant ids are URL-safe identifiers matching `^[a-zA-Z0-9_-]{1,64}$`. This
keeps them safe to embed in storage paths, Firestore field values, and
metering partition keys without additional encoding. Invalid values from
untrusted sources (e.g. the `X-AuraPix-Tenant-Id` header) are rejected by
the middleware and fall back to the default tenant.

## Billing / metering hooks

This ADR does not introduce metering events, but every metering event added
in the future MUST carry `tenantId` as its primary partition key. Aggregations
(storage bytes, processed images, plugin runs) MUST roll up by tenant first
and library second.

## Consequences

- All new code MUST set `tenantId` on document creation; the model defaults
  to `DEFAULT_TENANT_ID` so omission is safe but should be explicit at the
  boundary (handlers).
- Services MUST call `assertSameTenant` (or the equivalent repository-level
  filter) before returning or mutating tenant-scoped data.
- Repositories MAY add `tenantId` as a leading index field to support
  efficient per-tenant queries; Firestore indexes will be added in a follow
  up as queries are introduced.
- The `TENANT_AWARE_STORAGE_PATHS` flag stays off until a coordinated
  storage migration ships.

## Alternatives considered

- **Reusing `userId` as the tenant key.** Rejected: a single host customer
  can have many users (admins, editors, viewers), and AuraPix has no view
  into the host's user/account hierarchy.
- **Encoding tenant inside `libraryId`.** Rejected: libraries are a UX
  concept owned by the host customer; coupling tenant identity into the
  library id would make per-tenant rollups (storage, quotas) impossible
  without re-parsing strings.
