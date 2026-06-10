# Simulation Packs Restart and E2E Verification

Date: 2026-05-21
Environment: `ghoststack.rideai.com.au`

## Requirement

Restart related Docker services and test end-to-end that the GhostDASH `Simulation Packs` menu/page and export flow are working.

## Restart Performed

- Ran full stack rebuild/restart:
  - `docker compose up -d --build`

## Evidence and Verification

### Baseline checks

- `git status -sb` captured (dirty tree acknowledged, no unrelated files modified by this run).
- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'` captured.
- Edge logs captured from `ghoststack-rag-caddy-1`.
- Control plane logs captured from `ghoststack-rag-control-api-1`.

### Compose/runtime checks

- `docker compose ps` -> all core services up and healthy (`caddy`, `ui`, `control-api`, `agent-ingress`, `workflow-runtime`, `qdrant`, `postgres`).
- `docker compose config` -> valid rendered config.

### API and route checks

- `GET https://ghoststack.rideai.com.au/analysis/simulation-packs` -> `200`, GhostDASH app shell served.
- `GET https://ghoststack.rideai.com.au/api/elevenlabs/analysis/simulations?limit=5` -> `200`, `ready=true`, items present.
- `GET /api/elevenlabs/analysis/simulations/{file}` -> includes `elevenlabs_test_payload` with:
  - `type: "llm"`
  - populated `chat_history`
  - `from_conversation_metadata`

### Browser human-style verification

- Opened `https://ghoststack.rideai.com.au/analysis/simulation-packs` in browser automation.
- Confirmed left navigation item `Simulation Packs` is visible and active.
- Confirmed simulation list renders entries (e.g., `Bike Status Transfer`).
- Confirmed strict JSON pane is populated.
- Confirmed `Copy JSON` control is visible and actionable in loaded state.

## Tests Run

- `python3.12 -m pytest tests/test_elevenlabs_simulations_api.py -q`
  - Result: `2 passed, 1 warning`

## Findings

- Functional result: PASS for restart + menu/page visibility + API list/detail + JSON render.
- No blocking runtime errors observed in control-api logs during this validation window.

## Fixes Applied During Verification

- Corrected test invocation path typo:
  - initial: `backend/tests/test_elevenlabs_simulations_api.py` from `backend/` working dir (not found)
  - corrected: `tests/test_elevenlabs_simulations_api.py`

## Remaining Risk

- Simulation pack data currently depends on runtime-accessible artefact location. If container volume mappings change, list population can regress; keep `/app/artefacts/call-simulations` (or configured data dir) available in deployments.
