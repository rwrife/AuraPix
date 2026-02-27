# Architecture Boundaries

AuraPix uses a layered architecture to keep core domain logic provider-agnostic and easy to evolve.

## Layer order (inner → outer)

1. **Domain (`src/domain`)**
   - Pure business contracts and types
   - No framework/runtime/provider coupling
2. **Adapters (`src/adapters`)**
   - Infrastructure implementations (Firebase, in-memory, etc.)
   - Implement domain contracts
3. **Features/UI (`src/features`, `src/components`, `src/pages`)**
   - User-facing flows and presentation
   - Consume services/contracts only through explicit boundaries

## Allowed dependency direction

- `domain` → `domain` (types/contracts only)
- `adapters` → `domain`
- `features/pages/components/services` → `domain` and `adapters`

## Disallowed dependency direction

- `domain` importing from:
  - `adapters`
  - `features`
  - `components`
  - `pages`
  - `services`
- `adapters` importing from UI layers (`features`, `components`, `pages`)

## Guardrail enforcement

ESLint enforces these rules via `no-restricted-imports` in `eslint.config.js`:

- Domain modules cannot import outer-layer modules.
- Adapters cannot import UI-layer modules.

This catches architectural drift during normal CI lint runs.

## Examples

✅ Allowed

- `src/adapters/auth/FirebaseAuthService.ts` imports from `src/domain/auth/*`
- `src/features/auth/useAuth.ts` imports from `src/domain/auth/*`

❌ Forbidden

- `src/domain/albums/*` importing `src/adapters/albums/*`
- `src/domain/*` importing `src/features/*`
- `src/adapters/*` importing `src/pages/*`
