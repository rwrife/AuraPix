# AuraPix

A modern photo management and sharing platform built with React, TypeScript, and Firebase.

## Features

- 📸 Photo library management and organization
- 📁 Albums and folder organization
- 🔐 User authentication and authorization
- 🎨 Non-destructive image editing with plugin system
- 🤝 Photo sharing and access control
- 👥 Team collaboration with role-based permissions
- ☁️ Cloud storage with Firebase
- 📱 Responsive design for desktop and mobile

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Firebase project (for production deployment)

### Installation

```bash
# Install root dependencies
npm install

# Install backend dependencies
npm --prefix functions install
```

### Development

Run both frontend and backend concurrently in development mode:

```bash
npm run dev
```

This will start:
- Frontend (Vite): http://localhost:5173
- Backend (Express): http://localhost:3001

The frontend will automatically connect to the local backend and display a warning banner if the backend is unavailable.

### Environment Configuration

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```

2. Update the backend URL if needed:
   ```
   VITE_API_BASE_URL=http://localhost:3001  # For local development
   ```

3. For Firebase deployment, update to your Cloud Functions URL:
   ```
   VITE_API_BASE_URL=https://your-project.cloudfunctions.net/api
   ```

### Running Services Separately

```bash
# Frontend only
npm run dev:frontend

# Backend only
npm run dev:backend
```

### Building for Production

```bash
# Build both frontend and backend
npm run build

# Build separately
npm run build:frontend
npm run build:backend
```

## Project Structure

```
AuraPix/
├── src/                    # Frontend React application
│   ├── components/        # Reusable UI components
│   ├── pages/            # Page components
│   ├── services/         # Service layer and API clients
│   ├── features/         # Feature modules
│   ├── domain/           # Business logic and contracts
│   └── adapters/         # Data adapters
├── functions/            # Backend Node.js API
│   ├── src/
│   │   ├── handlers/    # Request handlers
│   │   ├── services/    # Business logic services
│   │   ├── adapters/    # Storage and data adapters
│   │   ├── routes/      # API routes
│   │   └── middleware/  # Express middleware
│   └── test/           # Backend tests
└── docs/               # Documentation
```

## Health Monitoring

The application includes automatic backend health monitoring:

- Frontend checks backend availability every 30 seconds
- A warning banner appears at the top if the backend is unreachable
- Health status is displayed with error details
- No user action required - monitoring is automatic

## Testing

```bash
# Run frontend tests
npm test

# Run backend tests
npm --prefix functions test

# Run with coverage
npm run test:coverage

# Validate API contract + breaking-change gate
npm run contract:check
```

### Upload-session CI parity checks

Run these before opening a PR that touches upload-session/query/index paths:

```bash
# from AuraPix repo root
npm ci
npm run firestore:indexes:validate
npm run test:uploads:firebase-adapter
npm run test:uploads:firebase-emulator
```

`npm run test:uploads:firebase-emulator` now includes a deterministic preflight that fails fast with actionable output when Java, emulator tooling, or required files are missing.

### Firebase Emulator Prerequisites

The upload emulator test command is designed to be one-command runnable from a fresh checkout after dependency install:

```bash
npm ci
npm run test:uploads:firebase-emulator
```

Preflight requirements:
- Java runtime available on `PATH` (`java -version` succeeds).
- Root dependencies installed (`node_modules` exists).
- `functions/firebase.json` and the emulator test file exist.
- `npx -y firebase-tools@14.3.1 --version` is executable.

## Architecture

AuraPix follows a clean architecture approach with:

- **Frontend**: React + TypeScript + Vite
- **Backend**: Node.js + Express + TypeScript
- **Data Layer**: Firestore (metadata) + Cloud Storage (media)
- **Authentication**: Firebase Authentication
- **Deployment**: Firebase App Hosting + Cloud Functions

See [docs/](./docs/) for detailed architecture documentation, including [layer boundaries and import guardrails](./docs/ARCHITECTURE_BOUNDARIES.md) and feature-level guides such as [tenant data export + hard offboarding](./docs/features/tenant-offboarding.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

Copyright © 2024 AuraPix. All rights reserved.
