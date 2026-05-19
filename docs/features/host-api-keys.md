# Per-tenant Host API Keys

Host backends (the services that integrate AuraPix into a larger product) need
to make server-to-server calls — reading usage for billing, listing libraries
during tenant onboarding, triggering data exports — _without_ impersonating an
end user. Per-tenant API keys solve this with a least-privilege, auditable
credential bound to a single tenant.

Issue: [#131](https://github.com/rwrife/AuraPix/issues/131). This feature
ultimately depends on the `tenantId` data-model foundation (#129 / #134); until
that lands, `tenantId` is a free-form identifier supplied by the admin
endpoint and is not yet cross-referenced against a `tenants` collection.

## Key format

```
ak_live_<43 chars of base64url>
```

The first 12 characters (`ak_live_xxxx`) are stored as `keyPrefix` so we can
look up a candidate row in Firestore by an indexed equality query, then verify
the full key with a SHA-256 hash compare.

## Firestore layout

Collection `tenantApiKeys/{keyId}`:

| Field          | Type             | Notes                                           |
| -------------- | ---------------- | ----------------------------------------------- |
| `id`           | string           | Document id; mirrored in body for convenience   |
| `tenantId`     | string           | The tenant this key is bound to                 |
| `keyPrefix`    | string           | First 12 chars of plaintext, indexed for lookup |
| `hashedSecret` | string           | SHA-256 hex digest of the plaintext key         |
| `scopes`       | string[]         | Subset of supported scopes (see below)          |
| `createdAt`    | ISO-8601 string  | Creation timestamp                              |
| `lastUsedAt`   | ISO-8601 \| null | Updated best-effort on each successful auth     |
| `revokedAt`    | ISO-8601 \| null | When non-null, the key is rejected              |
| `label`        | string?          | Optional human-readable label                   |

Indexes (`firestore.indexes.json`): `(keyPrefix, revokedAt)` for lookup,
`(tenantId, createdAt desc)` for the admin list view.

## Supported scopes

| Scope          | What it allows                                                              |
| -------------- | --------------------------------------------------------------------------- |
| `usage.read`   | Read storage usage rollups for libraries owned by the bound tenant          |
| `tenants.read` | Read tenant configuration (not yet wired; reserved for the #129 follow-up)  |

Future scopes such as `admin.users` and `libraries.write` are intentionally
out of scope for this release.

## Admin endpoints

All `/internal/tenants/:tenantId/api-keys*` endpoints require an admin user
(see `ADMIN_USER_IDS` env var, comma-separated UIDs or emails). Host API keys
themselves can never be used to manage other keys.

### Create

```
POST /internal/tenants/{tenantId}/api-keys
Authorization: Bearer <admin firebase id token>
Content-Type: application/json

{
  "scopes": ["usage.read"],
  "label": "billing-rollup-prod"  // optional
}
```

Response 201:

```json
{
  "key": {
    "id": "tak_...",
    "tenantId": "tenant-acme",
    "keyPrefix": "ak_live_abcd",
    "scopes": ["usage.read"],
    "createdAt": "2026-05-18T12:00:00.000Z",
    "lastUsedAt": null,
    "revokedAt": null,
    "label": "billing-rollup-prod"
  },
  "secret": "ak_live_<43 chars>"
}
```

**The `secret` field is shown exactly once.** AuraPix only stores the SHA-256
hash; if the plaintext is lost the key must be revoked and re-issued.

### List

```
GET /internal/tenants/{tenantId}/api-keys
```

Returns `{ "keys": [...] }` with `hashedSecret` stripped. Revoked keys are
included (with `revokedAt` set) so operators can audit history.

### Revoke

```
DELETE /internal/tenants/{tenantId}/api-keys/{keyId}
```

Soft-deletes by setting `revokedAt`. Subsequent requests using that key are
rejected with 401. Revocation is idempotent.

## Calling AuraPix with a key

```
GET /internal/storage-usage/{libraryId}?tenantId=tenant-acme
Authorization: Bearer ak_live_<...>
```

Behavior:

- Missing/invalid/revoked key → 401.
- Valid key without the required scope → 403 with `{ error, missing: [...] }`.
- Valid key whose `tenantId` does not match the resource's tenant → 403
  (`"Cross-tenant request rejected"`).
- Otherwise: handled as the authenticated tenant, with `req.tenant = { id,
  scopes, keyId }` available to downstream handlers.

The same endpoint also accepts a logged-in admin user as before, so existing
internal tooling keeps working.

## Rotation

There is no in-place "rotate" operation. The recommended pattern is:

1. Create a new key with the same scopes (`POST .../api-keys`).
2. Roll it out to your host backend.
3. Once you've confirmed the new key is in use (`lastUsedAt` advances),
   revoke the old one (`DELETE .../api-keys/{oldKeyId}`).

Plan for at least one rotation window of overlap so an in-flight deploy
doesn't get caught between revocation and rollout.

## Metering and audit

- Each successful key-authenticated request emits a sampled
  `metering.key.used` log line (`{ tenantId, keyId, path }`) at ~10% rate so
  the host can audit which integrations are active without exploding log
  volume.
- The `api_call.count` aggregate added in the rollup issue is incremented on
  every key-authenticated call.

## Security notes

- Plaintext keys are never logged or persisted; only the SHA-256 hash is
  stored.
- Hash comparison uses `crypto.timingSafeEqual` (constant-time).
- Lookups are O(1) by `keyPrefix`; the prefix collision space is large enough
  (≈2^60) that practical collisions are vanishingly unlikely, but the code
  still iterates and constant-time-compares all candidates returned for a
  given prefix.
- Keys are bound to a single tenant; cross-tenant calls return 403.
