# Tenant Data Export + Hard Offboarding

> Status: Implemented (issue #155) \u2014 see `contracts/openapi/tenant-offboarding.openapi.json` for the wire contract.

When a host application's customer churns, AuraPix gives the host two
first-class operations:

1. **Export.** Hand the customer a downloadable copy of their data.
2. **Hard-delete.** Irreversibly wipe every byte AuraPix stores for that
   tenant.

Both endpoints satisfy baseline GDPR / CCPA requirements that every
embeddable SaaS must support, and both are gated by a new
`tenant.admin` scope on the host API key surface (see
[host-api-keys](./host-api-keys.md)).

## Auth model

| Endpoint                                              | Bearer (end-user) | Host API key + `tenant.admin` |
| ----------------------------------------------------- | ----------------- | ----------------------------- |
| `POST   /v1/tenants/:id/export`                       | \u274c **401**         | \u2705                             |
| `GET    /v1/tenants/:id/exports/:exportId`            | \u274c **401**         | \u2705                             |
| `DELETE /v1/tenants/:id`                              | \u274c **401**         | \u2705                             |

Offboarding is an operational, host-business decision. Even an
authenticated tenant owner is rejected with `401 HOST_KEY_REQUIRED` if
they call these endpoints with a Firebase user token. The router uses
its own `requireHostKeyAdmin` guard rather than the more permissive
`requireUserOrTenantScopes` used elsewhere in the codebase.

Cross-tenant requests (where the host key's bound tenant does not
match the path tenant) return `403 FORBIDDEN`.

## Export

```http
POST /api/v1/tenants/{tenantId}/export
Authorization: Bearer ak_live_...
```

Response (`202 Accepted`):

```json
{ "exportId": "exp_a1b2c3...", "status": "pending", "createdAt": "2025-01-01T00:00:00Z" }
```

Poll:

```http
GET /api/v1/tenants/{tenantId}/exports/{exportId}
Authorization: Bearer ak_live_...
```

When `status: "ready"`, the response includes:

- `downloadUrl` \u2014 signed URL valid for 24h, scoped to
  `exports/{tenantId}/{exportId}.zip`.
- `manifestSha256` \u2014 hex digest of the archive contents for
  tamper-evidence.
- `bytes` \u2014 archive size; hosts MAY bill egress on this.

The archive contains:

- Photo metadata (one JSON row per photo)
- Album metadata
- Library metadata
- Tenant branding, signing keys, usage rollups
- References to original storage paths under
  `tenants/{tenantId}/originals/`

Derivatives are excluded \u2014 they are re-generable from originals.
Audit logs are intentionally out of scope; they belong to a separate
compliance export surface.

> **Implementation note.** The first cut of the export worker runs
> synchronously in-process and produces a single NDJSON manifest at
> `exports/{tenantId}/{exportId}.ndjson` referencing original storage
> paths, rather than a self-contained ZIP. The shape of the public API
> matches the issue spec; a follow-up issue will swap in a real ZIP
> packer + background worker without changing the contract.

## Hard delete

```http
DELETE /api/v1/tenants/{tenantId}
Authorization: Bearer ak_live_...
X-Confirm-Tenant-Id: {tenantId}
```

The `X-Confirm-Tenant-Id` header **must** exactly match the path
`tenantId`. A missing or mismatched header returns `400
CONFIRMATION_REQUIRED`. This is a deliberate defense against
copy/paste-the-wrong-id accidents.

The sweep is **idempotent and resumable**:

- Progress is recorded in `tenantDeletions_{tenantId}/_progress`.
- Killing the process mid-sweep and re-invoking `DELETE` resumes from
  the next collection without re-emitting events.
- The final `tenant.deleted` event fires **exactly once**; resuming a
  completed delete is a no-op.

Swept surfaces:

- `libraries`, `albums`, `photos`, `uploadSessions`
- `tenantApiKeys`, `tenantBranding`
- `usageDaily`, `webhookDeliveries`
- All storage under `tenants/{tenantId}/`
- The `tenants/{tenantId}` doc itself (final step)

After completion, any subsequent request for that tenant's resources
returns `404`, and the metering bus emits no further events for that
tenant.

## Metering events

Three new event types (registered in
`services/metering/MeteringBus.ts`):

| Event                        | Emitted when               | Fields                                                       |
| ---------------------------- | -------------------------- | ------------------------------------------------------------ |
| `tenant.export.requested`    | export job enqueued        | `tenantId`, `resourceId` (exportId)                          |
| `tenant.export.completed`    | export archive written     | `tenantId`, `resourceId`, `bytes` (zip byte size)            |
| `tenant.deleted`             | hard-delete sweep finished | `tenantId`, `bytes` (negative free), `meta.itemsDeleted`     |

Daily `storageBytesDelta` reflects the negative byte delta on the
deletion day (driven by the `tenant.deleted` event's `bytes` field).

## Operational guidance

- Run an export **before** triggering delete. Once `tenant.deleted` has
  fired you cannot recover \u2014 originals are unlinked from storage.
- The `tenant.admin` scope is destructive; mint it on a dedicated
  short-lived host API key rather than reusing your `usage.read` key.
- Export download URLs are tenant-scoped; sharing the URL with another
  host-key holder of a different tenant returns 403 at fetch time.

## Related

- [Host API keys](./host-api-keys.md) \u2014 scope model and key
  lifecycle.
- [Metering events](./metering-events.md) \u2014 full catalogue of
  billable events.
- [Usage and billing](./usage-and-billing.md) \u2014 daily rollups,
  including the deletion-day storage delta.
