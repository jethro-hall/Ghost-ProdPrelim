# Call Analysis Branding Sweep — 2026-05-01

## Requirement
- Remove ElevenLabs references from the GhostDASH website surface for the analysis page and present this feature as "Call Analysis".

## Root cause
- UI route, sidebar label, header title, and page heading were still branded with `ElevenLabs`, exposing vendor naming directly in operator-facing website navigation and titles.

## Correct layer
- Frontend routing and presentation layer (`ui/`), not backend integration logic.

## Files changed
- `ui/src/App.tsx`
- `ui/src/components/Sidebar.tsx`
- `ui/src/components/Header.tsx`
- `ui/src/components/AppLayout.tsx`
- `ui/src/pages/ElevenLabsAnalysisPage.tsx`

## Change implemented
- Renamed website route from `/analysis/elevenlabs` to `/analysis/call-analysis` (including detail route).
- Updated sidebar item label to `Call Analysis`.
- Updated header title resolution to `Call analysis`.
- Updated wide-canvas route detection for the new route.
- Updated page heading to `Call Analysis`.
- Replaced upstream warning text with vendor-neutral messaging so users do not see provider names in warning banners.

## Why this is not a one-off patch
- Route, navigation, and title mapping were all aligned to one canonical product-facing name (`Call Analysis`) to prevent repeated vendor leakage across future UI work.

## Token/resource impact
- No added LLM calls or runtime cost.
- Frontend-only text/routing updates.

## Cleanup performed
- Removed website navigation references to the old analysis route.
- Removed provider-specific warning text from this page surface.

## Tests run
- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"`

## Test output
- TypeScript lint check passed (`tsc --noEmit`).
- Vite production build passed.
- No linter diagnostics in edited files.

## Manual verification steps
1. Open `https://ghoststack.rideai.com.au/analysis/call-analysis`.
2. Confirm sidebar label reads `Call Analysis`.
3. Confirm page header/title reads `Call analysis` and in-page heading reads `Call Analysis`.
4. Trigger upstream-unavailable state and confirm warning message is vendor-neutral.
5. Click a row and confirm navigation goes to `/analysis/call-analysis/:conversationId`.

## Risks / follow-ups
- Backend API paths and internal code symbols still use `elevenlabs` naming for integration ownership; this is internal and not website-facing.
- If strict full-product rebrand is desired, a broader internal symbol/endpoint rename can be planned separately with compatibility migration.
