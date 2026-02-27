# API Contract Versioning Policy

AuraPix API contracts are versioned with semantic versioning in each OpenAPI artifact (`info.version`).

## Contract artifacts

- `contracts/openapi/albums.openapi.json`

## Versioning rules

- **PATCH** (`x.y.Z`): non-breaking clarifications (description/examples only)
- **MINOR** (`x.Y.z`): additive, backward-compatible changes (new optional fields, new endpoints)
- **MAJOR** (`X.y.z`): breaking changes (removed endpoints, stricter request requirements, removed response fields/status codes)

## CI gate

CI compares the PR contract artifact against `origin/main` and fails when breaking changes are detected without a **major** version bump.

Run locally:

```bash
npm run contract:check
```

If you intentionally introduce a breaking change, increment `info.version` major in the artifact and include migration notes in the PR description.
