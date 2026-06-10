# Call Analysis Right-Side Glass Pop-Out Panel — 2026-05-01

## Summary of requirement
- Replace always-visible right-side conversation detail form with a transparent iPhone-style glass pop-out panel that opens when selecting a conversation.

## Root cause
- Detail panel was statically embedded in the split grid, creating constant visual weight and not behaving like an on-demand contextual drawer.

## Correct layer
- Frontend layout and interaction in `ui/src/pages/ElevenLabsAnalysisPage.tsx`.

## Existing components reused
- Existing route-driven selection (`/analysis/call-analysis/:conversationId`).
- Existing conversation detail tabs/content (Overview, Workflow, Transcription, Client data, Phone call).

## Files changed
- `ui/src/pages/ElevenLabsAnalysisPage.tsx`

## Architecture impact
- No backend or API contract changes.
- UI now uses an overlay/backdrop + fixed right-side pop-out panel for selected conversation details.

## Implemented change
- Removed always-on right detail section from the main grid.
- Added route-driven pop-out panel:
  - opens when `conversationId` is present
  - includes translucent backdrop
  - fixed right panel with glassmorphism styles (`bg-white/45`, `backdrop-blur-2xl`, soft border/shadow)
  - close action returns to `/analysis/call-analysis`
- Kept all existing conversation options/tabs inside the new panel.

## Why this is not a static patch
- Uses route state as the source of truth for panel open/close behavior, making it consistent for deep links and future panel enhancements.

## Token/resource impact
- No additional model calls.
- Frontend-only interaction change.

## Cleanup performed
- Removed redundant always-visible detail area.
- Preserved existing data loading logic and tab content; only changed presentation shell.

## Tests run
- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"`
- `docker compose up -d --build ui`
- `curl -sS -o /dev/null -w '%{http_code}\n' https://ghoststack.rideai.com.au/analysis/call-analysis`

## Test output
- TypeScript lint passed.
- Vite build passed.
- UI container rebuilt and started.
- Remote route returned HTTP `200`.

## Manual human verification steps
1. Open `https://ghoststack.rideai.com.au/analysis/call-analysis`.
2. Select a conversation row.
3. Confirm transparent right-side glass panel pops out.
4. Confirm backdrop appears and click outside/Close button dismisses panel.
5. Confirm all tabs and options remain available inside panel.

## Known risks
- Panel height/width tuning may need a small adjustment for very short viewport heights.
