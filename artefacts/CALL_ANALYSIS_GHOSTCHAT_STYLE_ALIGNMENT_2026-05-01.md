# Call Analysis Panel ↔ GhostChat Style Alignment — 2026-05-01

## Requirement

Operator feedback: Call Analysis right panel still looked like a grey box, was not visibly transparent, and did not feel consistent with GhostChat popup behavior.

## Root cause

The Call Analysis panel had drifted into custom one-off styling (`custom gradient + bespoke handle`) instead of reusing established GhostDASH popup primitives used elsewhere.

## Correct layer

UI component layer in `ui/src/pages/ElevenLabsAnalysisPage.tsx`.

## Existing component/pattern reused

- `glass-popup` surface from `ui/src/index.css` (used by right-side popup patterns).
- `glass-chat` trigger styling from GhostChat visual language.
- Spring motion pattern aligned to existing GhostChat cadence (`stiffness: 300`, `damping: 30`).

## Files changed

- `ui/src/pages/ElevenLabsAnalysisPage.tsx`

## Change implemented

1. Backdrop normalized to Ghost popup pattern (`bg-black/20 backdrop-blur-[2px]`).
2. Conversation panel switched to `glass-popup` and anchored to right edge while remaining vertically centered (`right-0 top-1/2 -translate-y-1/2`).
3. Entry/exit animation normalized to side-panel slide (`x: "100%" → 0`) with spring settings matching GhostChat motion feel.
4. Retracted handle switched to `glass-chat` styling for visual consistency.
5. Inner cards/transcript surfaces reduced opacity to keep transparent/frosted appearance instead of opaque grey.

## Why this is not a one-off

This removes custom panel styling drift and re-centers the page on shared GhostDASH popup primitives. Future UI tweaks can follow the same shared class system instead of per-page ad hoc gradients.

## Token/resource impact

No backend/runtime impact. UI-only CSS/class/motion changes.

## Cleanup

- Removed dependence on custom backdrop gradient and bespoke panel treatment in this page.
- Replaced with shared primitives to reduce style divergence risk.

## Tests and proof

### Automated

- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"` ✅
- `docker compose up -d --build ui` ✅
- `docker compose config` ✅

### Human QA script (live)

1. Hard refresh: `https://ghoststack.rideai.com.au/analysis/call-analysis`.
2. Select a conversation row.
3. Confirm panel opens from right edge and is vertically centered.
4. Confirm panel and handle use consistent Ghost glass language with visible transparency.
5. Click backdrop to close, then reopen via handle.
6. Use `Prev`/`Next` in panel and confirm smooth transitions.

## Known risks

- Browser cache can mask style updates; hard refresh required.
