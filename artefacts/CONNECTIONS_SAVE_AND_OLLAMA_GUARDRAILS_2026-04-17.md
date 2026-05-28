# Connections Save + Ollama Guardrails (2026-04-17)

## Problem Statement

Two UX failures were reported in GhostDASH:

1. Saving provider changes from the Connections side panel appeared to not persist.
2. `gemini-pro` was being used against an Ollama endpoint, which is a provider/model mismatch.

## Root Causes

### 1) Stale `/connections` view after save

- The save flow in `RightPanel` called `saveConnection` successfully.
- `AppLayout` refreshed its local `connections` state.
- `ConnectionsPage` maintained an independent list loaded on mount and did not refresh after panel save.
- Result: persistence worked in backend, but page looked stale until manual refresh.

### 2) Gemini model against Ollama endpoint

- Ollama endpoints are OpenAI-compatible transport, not Google Gemini native API.
- `provider_kind=google_gemini` + `base_url=...:11434...` + `model=gemini-pro` leads to user confusion and failed tests.

## Architecture Changes

### Cross-view refresh contract

- Added `CONNECTIONS_UPDATED_EVENT` in `AppLayout`.
- Emitted this event after successful provider save and connection refresh.
- Subscribed in `ConnectionsPage` to re-fetch list/capabilities when the event fires.

This keeps panel save and page list in sync without introducing duplicate data stores.

### Ollama guardrails in `RightPanel`

- Added `isLikelyOllamaBaseUrl(...)` heuristic for local Ollama URLs.
- Added `effectiveProviderKind(...)` to auto-switch `google_gemini` to `openai_compatible` when Ollama URL detected.
- Added model precheck: if Ollama URL and model begins with `gemini`, block test with a clear actionable message.
- Added explicit save error surface (`saveError`) so failed save operations are visible in UI.
- Added inline helper text clarifying Ollama model expectations.

## Files Changed

- `ui/src/components/AppLayout.tsx`
  - Added `CONNECTIONS_UPDATED_EVENT`.
  - Dispatches event after successful save.
- `ui/src/pages/ConnectionsPage.tsx`
  - Added event listener and reactive refresh wiring.
- `ui/src/components/RightPanel.tsx`
  - Added robust API error extraction (Axios path).
  - Added save error UI feedback.
  - Added Ollama URL detection + provider kind normalization + model mismatch guardrail.

## Verification Performed

- Type-check:
  - `./ui/node_modules/.bin/tsc --noEmit -p ui/tsconfig.json` -> pass
- Lint diagnostics:
  - no linter errors on touched UI files
- API persistence smoke:
  - `POST /api/connections` for `ollama-e2e` -> persisted
  - `GET /api/connections` includes `ollama-e2e` record

## Known Limitation

Browser subagent run could not reach localhost in its execution context for full visual confirmation.  
Host-side service health and API responses are healthy; human click-path validation should be run in the local browser session.

