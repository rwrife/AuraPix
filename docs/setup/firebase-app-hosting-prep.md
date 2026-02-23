# Firebase App Hosting Prep (Non-blocking)

This document prepares AuraPix for Firebase App Hosting without locking the architecture to Firebase.

## Principles

1. Keep core app code provider-agnostic.
2. Isolate infrastructure-specific setup in dedicated config/docs.
3. Maintain a deployable baseline on generic platforms first.

## What is already ready

- Vite-based frontend build output (`dist/`)
- Environment-driven runtime configuration
- CI checks that ensure production build health

## Next steps when enabling Firebase App Hosting

1. Add Firebase project-level config and deployment workflow.
2. Map runtime environment variables in Firebase App Hosting settings.
3. Add preview deployment workflow per pull request.
4. Add rollback/deployment verification docs.

## Boundaries to keep

- Do not hardcode Firebase SDK initialization in shared domain modules.
- Keep storage/auth interfaces abstract so non-Firebase adapters remain possible.
- Ensure backend API contracts stay stable independent of hosting provider.
