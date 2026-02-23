# Contributing to AuraPix

Thanks for helping build AuraPix.

## Development flow

1. Create a branch from `main`
2. Make focused changes
3. Run checks locally:
   - `npm run lint`
   - `npm run test`
   - `npm run build`
   - `npm run format:check`
4. Open a pull request with context and validation output

## Pull request guidelines

- Keep PRs small and reviewable
- Explain what changed and why
- Include screenshots for UI changes when relevant
- Link related issues or roadmap docs

## Code style

- TypeScript strict mode
- ESLint + Prettier enforced in CI
- Prefer composition and clear boundaries over framework lock-in

## Architecture expectations

- Maintain vendor-neutral interfaces in core code
- Keep Firebase-specific integration modular and optional
- Document non-obvious decisions in `docs/`
