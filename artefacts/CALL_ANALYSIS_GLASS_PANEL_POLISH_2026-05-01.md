# Call Analysis Glass Panel Polish — 2026-05-01

## Requirement

The right-side conversation panel on `Call Analysis` looked like a flat grey box instead of a centered iPhone-style glassmorphism pop-out with a smooth right-edge spring slide.

## Root Cause

1. Panel surface used a low-contrast flat translucent white (`bg-white/45`) that read as grey on top of the existing dim overlay.
2. Overlay tint (`bg-slate-900/10`) darkened the viewport enough to kill the glass effect.
3. Slide animation did not start far enough off-screen to visually read as a right-edge pop-out.
4. Retracted handle lacked matching glass treatment, making the interaction look disconnected.

## Files Changed

- `ui/src/pages/ElevenLabsAnalysisPage.tsx`

## Change Implemented

1. Upgraded panel animation spring for stronger, smoother entry.
2. Changed panel enter/exit origin to off-screen right (`x: "112%"`) for clear right-side pop-out behavior.
3. Replaced flat panel background with layered gradient glass and stronger blur/saturation.
4. Added soft orb highlights inside the panel to improve depth and translucency.
5. Replaced dark backdrop with subtle radial glass haze.
6. Restyled the retracted handle to match the same glass language.
7. Reduced inner card opacity inside the panel so content looks frosted, not boxed.

## Verification

### Automated

- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"` ✅
- `docker compose up -d --build ui` ✅
- `docker compose config` ✅

### Runtime checks

- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'` ✅
- `docker logs --tail=120 ghost-edge-gateway` → container name not present in this runtime (`ghoststack-rag-caddy-1` is active edge container).
- `docker logs --tail=120 ghost-control-plane` → container name not present in this runtime (`ghoststack-rag-control-api-1` is active control-plane container).

## Human QA Script

1. Open `https://ghoststack.rideai.com.au/analysis/call-analysis`.
2. Click any conversation row.
3. Confirm panel enters from far right and settles centered vertically.
4. Confirm panel background is transparent glass (you can see blurred table beneath).
5. Click backdrop and confirm smooth retract.
6. Re-open with handle and confirm handle visually matches panel.
7. Use `Prev`/`Next` and confirm no jank during conversation switch.

## Risks

- Extremely low-contrast displays can still perceive panel as slightly flatter than intended; next pass would tune contrast tokens in `ui/src/index.css` for a global glass scale.
