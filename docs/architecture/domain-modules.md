# Domain module skeleton (Phase 1)

This increment introduces explicit domain boundaries in `functions/src/domain`:

- `albums`: album entities + repository contract + application service
- `library`: access-policy contract
- `sharing`: sharing-policy contract
- `auth`: identity resolution contract

## Adapter mapping

In-memory adapters now live in `functions/src/adapters/domain/in-memory` and implement each domain contract.

These are wired in the composition root (`functions/src/composition/domainModules.ts`) so runtime can switch to provider-backed adapters later without changing domain contracts.

## Vertical slice in this increment

A minimal API slice is now available for albums in local/mock auth mode:

- `GET /api/albums` list current user's albums
- `POST /api/albums` create album (`{ "title": "...", "description"?: "..." }`)

This delivers a demoable/user-usable backend slice while preserving compatibility with existing routes.
