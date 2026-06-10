# Call Analysis Overlay Conflict Fix — 2026-05-01

## Requirement

Operator reported the panel still appeared at the bottom and unreadable on Call Analysis.

## Root cause

`GhostChatMirror` is a fixed bottom overlay with `z-[9999]`. When opened, it sits above the Call Analysis panel (`z-50`) and visually dominates the viewport, making the right-side analysis panel appear broken and clipped.

## Correct layer

Layout orchestration layer (`ui/src/components/AppLayout.tsx`) that decides when global overlays should render.

## Existing component/pattern reused

No new UI components introduced. Reused route state in `AppLayout` to control `GhostChatMirror` visibility per route.

## Files changed

- `ui/src/components/AppLayout.tsx`

## Proposed + implemented change

1. Added `isCallAnalysisRoute` route flag.
2. Auto-close chat state when entering Call Analysis routes.
3. Suppressed `GhostChatMirror` render on `/analysis/call-analysis*`.

This prevents bottom overlay collisions with the right-side Call Analysis panel.

## Why this is not a static patch

This removes a systemic overlay conflict at the layout level instead of trying to keep increasing z-index on individual pages. It prevents recurrence on all Call Analysis detail states.

## Token/resource impact

UI only. No backend/token/runtime cost.

## Cleanup performed

- Removed conflicting GhostChat overlay behavior on Call Analysis routes.

## Tests run

### Automated

- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"` ✅
- `docker compose up -d --build ui` ✅
- `docker compose config` ✅

### Manual QA script (human flow)

1. Hard refresh `https://ghoststack.rideai.com.au/analysis/call-analysis`.
2. Select a conversation.
3. Confirm no GhostChat bottom overlay appears on this route.
4. Confirm right panel is readable and not clipped by another surface.
5. Navigate away from Call Analysis and confirm GhostChat launcher is available again.

## Known risks

- If operators explicitly need GhostChat while viewing Call Analysis, we should add a deliberate route-level toggle later instead of always suppressing it.
