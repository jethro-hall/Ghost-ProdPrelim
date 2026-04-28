# Production Chat Implementation Evidence

Date: 2026-04-28

## Scope

Implemented the production-safe chat surface as a separate route beside the existing Agent Lab UI:

- Existing debug route remains `/ghost_chatui/`.
- New production route is `/prod_chatui/`.
- `/chat` redirect behavior is unchanged.
- Backend and frontend public presenters block customer-unsafe diagnostics.
- Voice output guard now uses the shared public forbidden-pattern detector.

## Build And Architecture Notes

Backend:

- Added `ghostdash_api.public_response_presenter`.
- Added `ChatRequest.surface` and only applies public shaping when `surface == "prod_chatui"`.
- `/agent/chat` and `/agent/chat/stream` keep internal persistence and debug payloads for non-production surfaces.
- Production stream strips citations, route decisions, raw tool payloads, usage, effective snapshots, and backend error text before serialization.
- Voice stream blocks public diagnostic output and returns the approved short recovery response.

Frontend:

- Added production-only presenter in `Ghost-chatUI/src/lib/presenters/publicResponsePresenter.ts`.
- Added `useProductionChat()` wrapper that sends `surface: "prod_chatui"` and presents historical messages before rendering.
- Added production components under `Ghost-chatUI/src/components/production/`.
- Added `ProductionChatPage` and route selection in `Ghost-chatUI/src/App.tsx`.
- Added `/prod_chatui/` Caddy routing to the existing `ghost-chatui` service.
- Changed production Vite asset base to route-relative output so `/prod_chatui/` and `/ghost_chatui/` can both load their own mounted assets.

## Verification Commands

Backend:

```bash
cd /var/llamaindex/ghoststack-rag
python3.12 -m compileall backend/src
python3.12 -m pytest backend/tests/test_public_response_presenter.py backend/tests/test_agent_ingress_public_stream.py backend/tests/test_voice_ingress_public_guard.py
docker compose config
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose ps
```

Frontend:

```bash
cd /var/Ghost-chatUI
npm run lint
npm run test -- src/lib/presenters/publicResponsePresenter.test.ts src/test/production-rendering.test.tsx src/test/production-route.test.tsx
npm run build
```

Human/browser smoke:

```bash
cd /var/Ghost-chatUI
npm run dev -- --host 0.0.0.0
open http://127.0.0.1:3000/prod_chatui/
```

## Findings

- Backend production presenter tests passed: forbidden public output becomes the safe fallback, diagnostic fields are stripped, finance cards keep only allowlisted public card/report payloads.
- Agent ingress stream tests passed: `/prod_chatui` stream blocks unsafe deltas while internal diagnostic persistence still stores the original evidence.
- Existing debug stream behavior is preserved when no production surface is supplied.
- Voice public guard test passed: diagnostic voice output is blocked and replaced with the approved recovery text.
- Frontend typecheck passed.
- Production UI targeted tests passed for presenter hygiene, route rendering, and finance card hygiene.
- Production bundle built successfully.
- Caddyfile syntax validated successfully.
- Compose services were running; core API services reported healthy.
- Browser smoke passed at `http://127.0.0.1:3000/prod_chatui/` before and after review fixes.

## Browser Smoke Notes

Viewports checked:

- Desktop: 1366 x 768.
- Mobile: 390 x 844.

Observed:

- `/prod_chatui/` loads successfully.
- Composer is visible and accessible.
- Advanced panel is hidden by default.
- Advanced panel opens and closes successfully.
- Desktop layout keeps controls visible.
- Mobile layout keeps composer and controls usable.
- Production banner shows safe copy: "Production chat is ready. Some operator-only controls may be unavailable in this environment."
- No application console errors were observed in the final smoke pass.

## Repairs And Retest

Issue:

- Local test/build/dev commands initially failed because prior root-owned generated folders blocked Vite writes.

Fix:

```bash
sudo chown -R ec2-user:ec2-user node_modules/.vite-temp dist
sudo chown ec2-user:ec2-user node_modules
```

Retest:

- `npm run test -- src/lib/presenters/publicResponsePresenter.test.ts src/test/production-rendering.test.tsx src/test/production-route.test.tsx` passed.
- `npm run build` passed.
- Dev server restarted cleanly on port 3000.
- Browser smoke passed after the cache ownership fix.

Review fix:

- Stream deltas are now buffered across chunk boundaries so split forbidden phrases do not serialize partial unsafe fragments.
- Backend finance allowlist now scans nested card/report payloads and drops unsafe card data.
- `/prod_chatui/` bootstrap and workflow runs use the production surface marker instead of `ghost_chatui`.
- Production status banner no longer renders raw hook/backend status text.
- Production build assets are route-relative, avoiding a hard dependency on `/ghost_chatui/` asset URLs.

Review retest:

- Backend safety tests passed with split-delta and unsafe finance payload coverage.
- Frontend typecheck and production UI tests passed.
- Production build passed.
- Final browser smoke passed on desktop and mobile viewports.

## Acceptance Criteria

- `/ghost_chatui/` remains the detailed testing/debug UI.
- `/prod_chatui/` is a separate clean production chat surface.
- `/chat` redirect behavior is unchanged.
- Production main chat does not render citations, backend traces, scorecards, orchestrator failures, raw tool payloads, semantic/structured labels, or diagnostic metadata.
- Unsafe streaming output is replaced before production display.
- Finance output renders as a compact production card with safe details only.
- Voice output guard blocks unsafe diagnostic text.
- Tests and build commands above pass.

## Deployment Note

Code and build verification are complete. Running Docker services were not rebuilt or restarted as part of this implementation pass. To activate in the compose stack, rebuild/restart at least `agent-ingress`, `ghost-chatui`, and reload/restart `caddy`.

## Docker Restart And Live Route Test

Timestamp: 2026-04-28 03:40 AEST

Restart command:

```bash
cd /var/llamaindex/ghoststack-rag
docker compose up -d --build agent-ingress ghost-chatui caddy
```

Post-restart verification:

```bash
cd /var/llamaindex/ghoststack-rag
docker compose ps
curl -I -L --max-time 20 http://127.0.0.1/prod_chatui/
curl -I -L --max-time 20 http://127.0.0.1/ghost_chatui/
docker compose exec -T agent-ingress python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=5).read().decode())"
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
```

Result:

- `agent-ingress`, `control-api`, and `workflow-runtime` reported healthy after restart.
- `ghost-chatui` and `caddy` restarted and served the rebuilt production bundle.
- `/prod_chatui/` returned `200` after the expected HTTP-to-HTTPS redirect.
- `/ghost_chatui/` returned `200` after the expected HTTP-to-HTTPS redirect.
- `agent-ingress` internal health returned `{"status":"ok"}`.
- Caddy configuration validated successfully.

Human/browser smoke after Docker restart:

- `https://ghoststack.rideai.com.au/prod_chatui/` passed: clean production shell loaded, composer visible, advanced drawer hidden by default, drawer opened/closed, production-safe copy shown, mobile viewport remained usable.
- `https://ghoststack.rideai.com.au/ghost_chatui/` passed: detailed operator/debug UI loaded and remained distinct from the production shell.
- Browser automation could not access Docker through `127.0.0.1`, but shell route checks on localhost passed and the public domain browser test passed.

## Production Chat Readability And Drawer Fix

Timestamp: 2026-04-28 03:48 AEST

Problem reported:

- Production chat colours were too low contrast to read comfortably.
- Chat/composer content visually sat on top of or bled through the right advanced settings panel.

Fix:

- Replaced the production drawer glass surface with an opaque high-contrast panel.
- Raised the drawer and mobile overlay stacking layers.
- Added desktop right padding when the drawer is open so chat/composer content no longer sits under the panel.
- Strengthened text contrast in the top bar, status banner, message bubbles, composer, selected-agent control, drawer labels, and drawer action buttons.
- Rebuilt and restarted `ghost-chatui` and `caddy`.

Verification commands:

```bash
cd /var/Ghost-chatUI
npm run lint
npm run test -- src/test/production-route.test.tsx src/test/production-rendering.test.tsx
npm run build

cd /var/llamaindex/ghoststack-rag
docker compose up -d --build ghost-chatui caddy
docker compose ps ghost-chatui caddy
curl -I -L --max-time 20 https://ghoststack.rideai.com.au/prod_chatui/
```

Human/browser smoke:

- `https://ghoststack.rideai.com.au/prod_chatui/` passed at desktop `1366x768`.
- `https://ghoststack.rideai.com.au/prod_chatui/` passed at mobile `390x844`.
- Text and controls were readable.
- Composer placeholder and buttons were readable.
- Advanced drawer opened and closed correctly.
- Chat/composer no longer overlapped or appeared above the drawer.
