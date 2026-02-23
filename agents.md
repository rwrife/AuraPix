# AGENTS: AuraPix Engineering Instructions

These instructions apply to the entire repository.

## Tech stack expectations

- Frontend: React + Vite + TypeScript
- Backend: Node.js (TypeScript preferred) on Firebase Cloud Functions and/or Cloud Run
- Data: Firestore (metadata) + Cloud Storage (media)
- Auth: Firebase Authentication

## Architecture principles

1. Prioritize photo management, organization, sharing, and permissions over advanced editing.
2. Keep image editing non-destructive and plugin-oriented.
3. Use a clear service layer for privileged operations rather than exposing all writes directly from clients.
4. Design APIs and data models to support future desktop clients.

## Firebase implementation guidelines

- Use separate Firebase projects for dev, staging, and production.
- Treat Firestore Security Rules and Storage Rules as first-class code with tests.
- Enforce role-based access checks server-side for sensitive operations (sharing, quota updates, bulk deletes).
- Use App Check on client-facing endpoints.
- Prefer idempotent Cloud Function handlers for upload/processing events.

## React + Vite conventions

- Use TypeScript across UI and shared models.
- Organize by feature modules (auth, library, albums, sharing, teams, plugins).
- Keep components small and composable.
- Use a query/cache strategy suitable for Firestore and API hybrid reads.

## Node.js service conventions

- Use explicit request validation (e.g., zod/yup/json-schema).
- Keep handlers thin and move business rules to services.
- Add structured logs with trace IDs for upload/share pipelines.
- Ensure every mutating endpoint has authorization and audit logging.

## Data and storage conventions

- Store originals and derivatives separately.
- Maintain deterministic storage paths based on tenant/library/photo IDs.
- Track storage usage in dedicated documents managed by backend code only.
- Favor append-only event logs for critical operations.

## Quality gates

- Run linting and tests before merging.
- Add or update tests when touching security-sensitive logic.
- Document major architecture decisions in `docs/` as ADR-style notes when needed.

## Documentation expectations

- Keep `README.md` high-level and user-focused.
- Maintain implementation roadmap in `docs/IMPLEMENTATION_PLAN.md`.
- Expand feature docs in `docs/features/` as implementation planning deepens.
