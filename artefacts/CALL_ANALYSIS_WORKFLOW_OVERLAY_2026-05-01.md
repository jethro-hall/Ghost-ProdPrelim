# Call Analysis Workflow Overlay — 2026-05-01

## Summary of requirement
- Add an easy-to-read workflow view in Call Analysis that shows in-depth tool-calling execution using transparent overlay cards.

## Root cause
- The existing detail view showed overview, transcript, and raw payload tabs but no operator-friendly workflow trace of tool calls.

## Correct layer
- UI detail experience in `ui/src/pages/ElevenLabsAnalysisPage.tsx`.

## Existing component reused
- Existing Call Analysis detail panel and tab framework in `ElevenLabsAnalysisPage`.

## Files changed
- `ui/src/pages/ElevenLabsAnalysisPage.tsx`

## Architecture impact
- No backend/API contract changes.
- Frontend now derives workflow events from existing `detail.analysis`, `detail.metadata`, and `detail.client_data` payloads.
- Adds deterministic parsing helpers and a new `Workflow` tab in the conversation detail view.

## Implemented change
- Added robust workflow extraction for tool-call events from multiple payload locations.
- Added transparent glass overlay cards per tool call with:
  - tool name and source
  - status badge
  - latency chip
  - input/output JSON snippets
  - error panel when present
- Added workflow summary chips (total/success/failure).

## Why this is not a static patch
- The parser accepts multiple possible payload shapes and nested call arrays, so the UI can keep working as upstream structures vary.

## Token/resource impact
- Zero additional model calls.
- Client-side parsing only; negligible runtime overhead.

## Cleanup performed
- No dead code introduced.
- Kept all existing tabs and routes intact; added one focused tab and local helper functions.

## Tests run
- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"`
- `docker compose up -d --build ui`
- `curl -sS -o /dev/null -w '%{http_code}\n' https://ghoststack.rideai.com.au/analysis/call-analysis`

## Test output
- TypeScript check passed (`tsc --noEmit`).
- Vite build passed.
- UI container rebuilt and started successfully.
- Remote route returned `200`.

## Manual human verification steps
1. Open `https://ghoststack.rideai.com.au/analysis/call-analysis`.
2. Select a conversation from the list.
3. Open the new `Workflow` tab.
4. Verify transparent overlay cards are visually readable and easy to scan.
5. Confirm each card shows status and timing.
6. Confirm input/output snippets can be scrolled and inspected.
7. Validate empty-state messaging appears when no tool calls exist.

## Known risks
- If upstream payloads omit tool-call fields entirely, workflow view will show empty state (expected).
- Very large input/output payloads may still be dense, though constrained with scrollable blocks.
