# Provider Delete Option Phase 1 (2026-04-17)

## Goal

Introduce a safe provider/connection delete option with explicit preflight checks and confirmation-token guardrails.

## Scope Delivered

- Added connection deletion preview contract and API route:
  - `POST /api/connections/{connection_id}/deletion-preview`
- Added guarded deletion route:
  - `DELETE /api/connections/{connection_id}?confirm=true`
  - Requires body `{ "confirmation_token": "..." }`
- Added runtime helper to remove a connection record.
- Added UI wiring in Connections panel (`RightPanel`) with:
  - Delete action for existing providers
  - Preview gate before delete
  - Blocking reason surface
  - Explicit confirmation dialog
- Added backend tests for seeded-provider protection, runtime-reference blockers, and successful unreferenced delete.

## Safety Rules Implemented

- Seeded providers are protected (`openai`, `google-gemini`).
- Connection is blocked if referenced by runtime defaults.
- Connection is blocked if referenced by any runtime profile (direct or provider-key fallback).
- Connection is blocked when impacted agents are in active workflow runs/steps.
- Delete execution requires both `confirm=true` and a matching `confirmation_token`.

## Data Impact Model

Preview impact payload reports:

- Runtime profile direct refs (`llm_config.connection_id`)
- Runtime profile provider refs (`llm_config.provider` when connection id is absent)
- Fallback refs (`llm_orchestration.fallback_connection_id`)
- Fallback provider refs (`llm_orchestration.fallback_provider` when fallback connection id is absent)
- Impacted agents and active workflow associations
- Runtime-default connection marker
- Seeded-provider marker

## Files Updated

- `backend/src/ghostdash_api/schemas.py`
- `backend/src/ghostdash_api/runtime.py`
- `backend/src/ghostdash_api/control_api.py`
- `backend/tests/test_connection_deletion_preview.py`
- `ui/src/api.ts`
- `ui/src/components/RightPanel.tsx`
- `ui/src/components/AppLayout.tsx`

## Verification Notes

- IDE lints on edited files: clean.
- Host-side `pytest` unavailable due missing local Python deps.
- Container image used by `control-api` service does not include test files by default, so direct in-container `pytest` path execution is not currently available without a test-enabled image.

## Recommended Runtime Verification

1. Open Connections panel.
2. Create an unreferenced provider.
3. Use Delete provider and confirm removal.
4. Attempt delete on `OpenAI` provider and confirm blocker message.
5. Attempt delete on a referenced provider and confirm blocker message.
