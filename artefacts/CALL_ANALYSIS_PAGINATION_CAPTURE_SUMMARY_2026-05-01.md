# Call Analysis Pagination + User Data Capture + Transcript Summary — 2026-05-01

## Summary of requirement
- Keep conversations page at 30 rows.
- Add forward/backward paging controls.
- Capture names/numbers from transcripts and show them in a `User data captured` field under conversations.
- Show transcript summary under conversations and widen conversations panel for readability.

## Root cause
- The conversations list had no previous/next pagination controls despite cursor support from API.
- List rows only showed title/date/status, with no transcript-derived context for operators.

## Correct layer
- UI layer (`ui/src/pages/ElevenLabsAnalysisPage.tsx`) because request is presentation and operator workflow enhancement on top of existing `/api` contracts.

## Existing components reused
- Existing `/api/elevenlabs/analysis/conversations` cursor API.
- Existing `/api/elevenlabs/analysis/conversations/{conversation_id}/transcript` API.
- Existing Call Analysis conversations table and detail layout.

## Files changed
- `ui/src/pages/ElevenLabsAnalysisPage.tsx`

## Architecture impact
- No backend schema or endpoint changes.
- Frontend now performs transcript enrichment for visible rows (page size 30) using existing transcript endpoint.
- Added cursor-stack paging state for deterministic backward/forward navigation.

## Implemented change
- Enforced page size constant `PAGE_SIZE = 30`.
- Added paging UI:
  - `Backward` button
  - `Next page` button
  - page badge (`Page N`)
- Added wider conversations pane for more context.
- Added two new conversation table fields:
  - `Transcript summary`
  - `User data captured`
- Added transcript summarization and user-data capture logic:
  - summary from first relevant transcript messages
  - names detected from user utterance patterns (`my name is`, `i am`, `this is`)
  - numbers detected from numeric patterns (phone/order-style strings)
  - context snippet attached to each captured value

## Why this is not a static patch
- Uses API cursor semantics and a reusable cursor stack instead of one-off page jumps.
- Uses deterministic transcript parsing with graceful fallbacks, so the UI remains useful even when transcript shape varies.

## Token/resource impact
- No additional LLM tokens used.
- Adds up to 30 transcript API reads per page (chunked concurrency of 5) for enrichment.

## Cleanup performed
- No dead code paths added.
- Existing filters and detail tabs remain intact.

## Tests run
- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"`
- `docker compose up -d --build ui`
- `curl -sS -o /dev/null -w '%{http_code}\n' https://ghoststack.rideai.com.au/analysis/call-analysis`
- `curl -sS "https://ghoststack.rideai.com.au/api/elevenlabs/analysis/conversations?limit=30"`

## Test output
- TypeScript lint passed (`tsc --noEmit`).
- Vite build passed.
- UI container rebuilt and restarted successfully.
- Remote call-analysis route returned `200`.
- API confirms limit/cursor payload with `next_cursor` and `has_more`.

## Manual human verification
1. Open `https://ghoststack.rideai.com.au/analysis/call-analysis`.
2. Confirm list shows up to 30 rows and page badge.
3. Click `Next page` then `Backward`; confirm navigation works.
4. Check each row shows `Transcript summary` and `User data captured` when transcript data exists.
5. Confirm wider list area allows readable summary/capture context.

## Known risks
- Transcript enrichment introduces extra API requests and may load progressively on large pages.
- Name extraction uses deterministic heuristics; some edge names may be missed or captured conservatively.
