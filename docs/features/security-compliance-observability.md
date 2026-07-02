# Feature Plan: Security, Compliance & Observability

## Objective
Ensure strong security posture, compliance readiness, and operational visibility.

## Scope
- Security Rules strategy and validation
- App Check and anti-abuse controls
- Audit logging for sensitive actions
- Metrics, tracing, and alerting baselines

## Planned detail expansion
- Security threat model and controls matrix
- Compliance workflows (deletion/export/retention)
- Monitoring dashboards and SLO candidates
- Incident detection and recovery playbooks

## Non-reversible identifier hashing

Several code paths need a stable identifier for a viewer — for
de-duplication, rate-limiting, or abuse tracking — without persisting
personally-identifiable data. These paths follow a single pattern:
**HMAC-SHA256 with a per-tenant secret**.

### Per-tenant secret derivation

The per-tenant secret is derived from the platform's master signing
secret:

```
perTenantSecret = HMAC-SHA256(masterSecret, "<seed>/<tenantId>")
```

The `<seed>` string is namespaced per use-case (for example
`share-view/<tenantId>`) so a hash lifted from one subsystem cannot be
compared against a hash lifted from another. The master secret never
leaves the process.

Properties:

- **Non-reversible.** The raw IP / UA / e-mail cannot be recovered from
  the hash. The best an attacker with the hash can do is offline-guess
  a known candidate value against a known tenantId + use-case seed.
- **Per-tenant isolation.** The same raw value (e.g. an IP) under two
  different tenants produces two different hashes. Tenants cannot
  correlate viewers across each other, and a data leak from one tenant
  does not deanonymise viewers of another.
- **Stable across restarts.** The derivation is deterministic so
  dedup and rate-limit lookups survive process restarts.

### Share-link view tracking (issue #198)

Every share-link resolution records a view row containing hashed
identifiers only:

- `ipHash = HMAC(perTenantSecret, requestIp)`
- `uaHash = HMAC(perTenantSecret, userAgent)`
- `referrerHost` — the host portion of the `Referer` header, **never**
  the full URL or query string.

Raw IP addresses, raw user-agent strings, and full referrer URLs are
**never persisted**. The tracker uses `(linkId, ipHash, uaHash)` as the
key for a 60-second de-dup window, which is sufficient to collapse the
sub-resource fetches of a single page load without giving hosts a
usable per-viewer identifier.

Raw view rows are retained for 90 days; aggregate counters (view count,
unique viewers, bytes served) persist indefinitely on the link doc but
carry no per-viewer data.

### Analytics endpoint privacy

`GET /v1/tenants/{tenantId}/share-links/{linkId}/analytics` returns only
aggregate numbers plus a 7-day time series. It never returns raw view
rows, IP hashes, UA hashes, or referrer values — those exist purely to
serve the de-dup + aggregation pipeline.
