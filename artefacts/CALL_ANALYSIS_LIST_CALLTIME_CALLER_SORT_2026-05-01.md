# Call Analysis List: Call Time + Caller Number + Ordering — 2026-05-01

## Summary of requirement
- In conversation list, show:
  - call time
  - number that called
  - ordering by DATE or STATUS

## Root cause
- The list lacked direct call-time and caller columns and did not provide an operator-facing order control.

## Correct layer
- UI table/view logic in `ui/src/pages/ElevenLabsAnalysisPage.tsx`.

## Existing component reused
- Existing conversation list rows and transcript enrichment state in Call Analysis page.

## Files changed
- `ui/src/pages/ElevenLabsAnalysisPage.tsx`

## Architecture impact
- No backend endpoint or schema changes.
- Added deterministic UI sorting and caller-number fallback from existing transcript extraction.

## Implemented change
- Added list columns:
  - `Caller number`
  - `Call time`
- Added order control with options:
  - `Order: Date`
  - `Order: Status`
- Added client-side sorted rows (`sortedRows`) while preserving existing filters/pagination.
- Caller number resolution order:
  1. `row.user_id`
  2. first transcript-derived captured number
  3. `Unavailable`

## Why this is not a static patch
- Uses reusable sort state and memoized sort computation.
- Integrates caller value with existing enrichment pipeline instead of hardcoding one source.

## Token/resource impact
- No extra model calls.
- Negligible client-side sort overhead.

## Cleanup performed
- Kept existing list fields and interaction behavior intact.
- No dead code introduced.

## Tests run
- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"`
- `docker compose up -d --build ui`
- `curl -sS -o /dev/null -w '%{http_code}\n' https://ghoststack.rideai.com.au/analysis/call-analysis`

## Test output
- TypeScript lint passed.
- Build passed.
- UI service rebuilt and restarted.
- Remote route returned HTTP `200`.

## Manual human verification steps
1. Open `https://ghoststack.rideai.com.au/analysis/call-analysis`.
2. Confirm conversation list includes `Caller number` and `Call time`.
3. Toggle sort to `Order: Date` and verify newest-first ordering.
4. Toggle sort to `Order: Status` and verify grouped status ordering.
5. Confirm rows still open details as expected.

## Known risks
- Caller number may be unavailable when upstream omits `user_id` and transcript has no numeric cues.
