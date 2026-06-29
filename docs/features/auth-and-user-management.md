# Feature Plan: Auth & User Management

## Objective
Provide secure user authentication and identity management for photographers and team members.

## Scope
- Email/password and OAuth provider sign-in
- Profile setup and account lifecycle
- Session management and App Check integration
- Identity linkages for personal and team workspaces

## Planned detail expansion
- Authentication flows and UX states
- Firebase Auth configuration by environment
- User profile schema in Firestore
- Account recovery and lockout handling
- Security rule considerations for user-level data

## Tenant user management API (host-API-key surface)

_Tracking issue: [#143](https://github.com/rwrife/AuraPix/issues/143)_

AuraPix is sold as embeddable multi-tenant from day one. Hosts need a way to
provision their customers' users into a tenant, change roles, and revoke
access — without going through Firebase Auth directly. Four endpoints are
exposed under the existing host-API-key surface (see
`contracts/openapi/tenant-users.openapi.json`):

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/tenants/{tenantId}/users` | `tenants:write` | Create a membership. Body: `{ email, userId?, role }`. **Does not send an email** — the host owns invite UX. |
| `GET` | `/v1/tenants/{tenantId}/users` | `tenants.read` | List active memberships with `role` and `lastActiveAt`. |
| `PATCH` | `/v1/tenants/{tenantId}/users/{userId}` | `tenants:write` | Change role. |
| `DELETE` | `/v1/tenants/{tenantId}/users/{userId}` | `tenants:write` | Revoke membership. The audit row is retained (`revokedAt` is stamped) so billing reconciliation can still see who was a member and when. |

### Storage

Memberships live at the per-tenant path `tenants/{tenantId}/members/{userId}`
(stored under composite id `{tenantId}__{userId}` in the flat key/value
adapter). They are **never global** — a user may belong to multiple tenants
and each membership is independent. Tenant context comes from the request,
not the user.

### Roles (intentionally minimal)

- `owner` — full tenant admin (manage users, branding, quotas).
- `editor` — read+write photos/albums.
- `viewer` — read-only.

Roles are enforced in the existing authz middleware alongside the existing
`tenantId` checks. A viewer cannot write; an editor cannot manage users; an
owner can do both. Future role expansion is additive.

### Cross-tenant requests return 404 (not 403)

Any request whose URL `tenantId` does not match the authenticated host API
key's tenant returns `404 Membership not found` (or `404` on the collection
endpoints). This is deliberate — a `403` would leak the existence of
resources in tenants the caller has no relationship with.

### Billing / metering hooks

- `user.provisioned` is emitted on every newly created membership (idempotent
  re-POSTs do **not** re-emit).
- `user.revoked` is emitted on every successful `DELETE`.
- `user.active` is emitted by request-scoped middleware **at most once per
  `(tenantId, userId)` per UTC day** — the per-seat billing signal hosts
  asked for in #143. Debounce is in-memory today; a shared store will swap
  in for multi-process deployments.

All three events are catalogued in
[`docs/features/metering-events.md`](./metering-events.md).

### Scope: `tenants:write`

`tenants:write` extends the existing host API key scope set (alongside
`usage.read` and `tenants.read`). Granted via the existing admin endpoint
(`POST /internal/tenants/:tenantId/api-keys`).

---

## Host-issued embed session tokens (SSO)

_Tracking issue: [#195](https://github.com/rwrife/AuraPix/issues/195)._

For host applications embedding AuraPix, asking already-signed-in end
users to authenticate a second time with Firebase Auth is a major
friction point. The embed session-token flow lets the host backend mint a
short-lived signed credential the embedded UI can exchange for a real
server-side session — no Firebase login prompt is shown.

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/tenants/{tenantId}/embed/session-tokens` | `tenants.write` | Mint a short-lived JWT for an already-authenticated end user. Body: `{ userId, role?, ttlSeconds? }` (`ttlSeconds` ≤ 300, default 120). The `userId` MUST already be a tenant member; non-members get `409 user_not_member`. |
| `POST` | `/v1/tenants/{tenantId}/embed/session-exchange` | (token in body) | Iframe-side redemption. Validates the JWT and returns the user's identity claims plus an optional opaque `session` payload (e.g. a Firebase custom token). Cross-tenant tokens are rejected; replays return `401 token_replayed`. |

Tokens are signed with the tenant's existing webhook signing secret
(issue #161), so secret rotation inherits the same dual-secret grace
window. The full handshake — token mint, postMessage forwarding, exchange
— is documented in [`embed-handshake.md`](./embed-handshake.md#host-issued-session-tokens-sso).

Membership is re-validated at exchange time, so revoking a user (per the
DELETE endpoint above) immediately invalidates any outstanding embed
tokens for that user.

