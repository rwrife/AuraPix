# AuraPix

AuraPix is an open-source foundation for photo management, sharing, and collaboration.

It is designed to stay **vendor-neutral first** while being **Firebase App Hosting-ready** when we choose to adopt managed deployment.

## Vision

- Fast, reliable media workflows for photographers and teams
- Secure-by-default sharing and access controls
- Extensible architecture for non-destructive editing plugins
- API-first direction so desktop and automation clients can be added later

## Current status (first practical increment)

This repo now includes:

- A lightweight React + Vite + TypeScript web baseline
- Lint, format, test, and build scripts
- Environment template and setup docs
- CI workflow for install/lint/test/build
- Community contribution basics (issues/PR templates, contributing guide, CODEOWNERS)
- Firebase App Hosting prep notes without coupling the architecture

## Quick start

### Prerequisites

- Node.js 22+
- npm 10+

### Local development

```bash
npm install
cp .env.example .env
npm run dev
```

### Quality checks

```bash
npm run lint
npm run test
npm run build
npm run format:check
```

## Documentation

- Implementation plan: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Environment setup: [`docs/setup/environment.md`](docs/setup/environment.md)
- Firebase App Hosting prep: [`docs/setup/firebase-app-hosting-prep.md`](docs/setup/firebase-app-hosting-prep.md)
- Feature planning docs: [`docs/features/`](docs/features)
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Repository structure

```text
src/                     Web app baseline
.github/                 CI + issue/PR templates
docs/                    Planning and setup docs
```

## Deployment direction

Near term:

- Keep deployment flexible and open-source friendly (any static host + API runtime)

Future-ready:

- Preserve compatibility with Firebase App Hosting for managed deployments
- Introduce Firebase-specific runtime wiring behind clear interfaces
