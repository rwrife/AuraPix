# Feature Plan: Plugin Editing System

## Objective
Provide a modular, non-destructive editing framework for lightweight image adjustments.

## Scope
- Plugin manifest and capability registration
- Edit recipe format and versioning
- Client preview and server-side render consistency
- Plugin enable/disable controls by plan/workspace

## Current implementation (incremental)
- Recipe contract versioning (`recipeVersion: 1`) on apply-edits payloads
- Plugin manifest endpoint (`GET /edits/plugins`) for client capability discovery
- Initial non-destructive plugin set exposed in manifest:
  - `crop`
  - `rotate`
  - `adjust` (brightness/contrast/saturation)
  - `filter` (grayscale/sepia/blur/sharpen/negate)
- Data model stores `recipeVersion` on every saved edit history entry

## Planned detail expansion
- Plugin API contract (input, params, output)
- Workspace/plan-based plugin enable/disable policy
- Additional plugin set: exposure/white-balance/highlights
- Data storage model for edit versions/history
