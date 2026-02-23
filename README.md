# AuraPix

AuraPix is a Firebase-powered photo management and sharing platform for photographers and teams.

The project focuses on:
- Fast upload and organization of large photo libraries
- Albums and higher-level collections
- Secure sharing to other photographers and anonymous viewers via links
- Team collaboration with role-based permissions
- Non-destructive, plugin-based lightweight edits (crop, brightness, exposure)

AuraPix is intentionally **not** a full photo editing suite. Editing is modular and extensible, while the core product remains centered on media management, collaboration, and secure delivery.

## Who this is for
- Independent photographers
- Studios and media teams
- Sports/event photographers delivering galleries to clients and communities

## Platform goals
- Build on Google Firebase primitives (Auth, Firestore, Cloud Storage, Functions, Hosting)
- Enforce strong security boundaries for private media
- Manage plan-based storage limits and lifecycle rules
- Provide a robust API for future desktop clients

## Project documentation
Start with the implementation roadmap:
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)

Then review feature-level breakdowns in:
- [`docs/features/`](docs/features)

## Initial architecture themes
- **Frontend:** React + Vite + TypeScript
- **Backend APIs:** Node.js services on Firebase Cloud Functions / Cloud Run
- **Data:** Firestore metadata + Cloud Storage originals/derivatives
- **Security:** Firebase Auth, App Check, Security Rules, role-aware service layer

## Development status
This repository currently contains foundational planning and execution docs. Implementation will follow the phased roadmap in the docs directory.
