# AuraPix Implementation Plan

This plan defines incremental execution for AuraPix with an open-source-first baseline and Firebase-ready optionality.

## Shipped increment: Foundation Kickoff (current)

Delivered in this increment:

- Web baseline scaffold (React + Vite + TypeScript)
- Quality gates (lint, format, unit test, build)
- Environment template and setup documentation
- CI workflow for install/lint/test/build/format check
- Contribution and collaboration templates
- Firebase App Hosting preparation notes (non-locking)

## Phase 1 — Core Domain Skeleton

Goal: establish domain boundaries and first vertical slice.

- Define domain modules: `library`, `albums`, `sharing`, `auth`
- Introduce API contract layer (OpenAPI or typed endpoints)
- Add first feature slice: list/create album (stubbed backend allowed)
- Add adapter pattern for storage/auth providers

## Phase 2 — Upload + Library MVP

- Upload flow with metadata persistence
- Gallery grid with pagination and basic filtering
- Background derivative generation contract (provider-agnostic)
- Storage limits and usage telemetry foundations

## Phase 3 — Sharing + Team controls

- Link-based sharing policies (expiry/password/revocation)
- Team roles and scoped resource access
- Audit events for critical actions

## Phase 4 — Plugin editing + API hardening

- Define plugin execution contract for non-destructive edits
- Add first plugins (crop/exposure/brightness)
- Harden API for desktop/third-party clients

## Cross-cutting requirements

- Security and least-privilege authorization
- Idempotent retry-safe background processing
- Cost-aware storage lifecycle controls
- Observability and operational readiness

## Success criteria

- New contributors can run and validate project in <10 minutes
- CI enforces quality gates on every PR
- Architecture remains provider-agnostic in core domains
- Firebase App Hosting can be enabled as an implementation detail
