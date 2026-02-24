import type { Services } from "./ServiceContext";

// ---------------------------------------------------------------------------
// Stub factory for the Firebase service bundle.
// Replace each `null as unknown as X` with real Firebase adapter instances
// once the Firebase adapters are implemented (Phase 2+).
//
// To activate: set VITE_SERVICE_MODE=firebase in your .env file.
// ---------------------------------------------------------------------------

export function createFirebaseServices(): Services {
  throw new Error(
    "Firebase services are not yet implemented. " +
      "Run with VITE_SERVICE_MODE=local (or unset) to use local mode.",
  );
}