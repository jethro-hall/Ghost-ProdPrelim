# PROD ChatUI Crash Fix Verification (2026-04-28)

## Requirement summary
- Fix agent-ingress crash and restore `https://ghoststack.rideai.com.au/prod_chatui/` functionality.

## Root cause
- `backend/src/ghostdash_api/agent_ingress.py` imports `integrations.elevenlabs_hubtiger.router`.
- `backend/src/integrations/*` exists in source, but packaging only installed `ghostdash_api` into the container image.
- Result: `ModuleNotFoundError: No module named 'integrations'` and ingress crash loop.

## Correct layer
- Backend packaging/build layer (`backend/pyproject.toml` wheel package inclusion), not UI or Caddy routing.

## Change implemented
- Updated `backend/pyproject.toml` to include both source packages in wheel builds:
  - `src/ghostdash_api`
  - `src/integrations`

## Files changed
- `backend/pyproject.toml`

## Verification and proof
1. Syntax/build sanity
   - `python3.12 -m compileall backend/src` -> success.
2. Regression test
   - `pytest backend/tests/test_elevenlabs_hubtiger_ingress.py` -> `2 passed`.
3. Runtime recovery
   - `docker compose up -d --build agent-ingress caddy` -> successful recreate/start.
   - `docker compose ps` shows:
     - `agent-ingress` **healthy**
     - `control-api` **healthy**
     - `caddy` **up**
4. Endpoint checks
   - `curl -sS -D - http://127.0.0.1/health -o /dev/null` -> HTTP 200.
   - `curl -sS -D - http://127.0.0.1/prod_chatui/ -o /dev/null` -> HTTP 308 redirect to production HTTPS route.
5. Human browser smoke
   - `https://ghoststack.rideai.com.au/prod_chatui/` now loads (`Ghost ChatUI` title).
   - Chat send flow (`/agent/chat/stream`) returns 200 and assistant response renders.
   - Voice call control toggles from `Call` to `End Call` (session starts).

## Latency observation
- Recent ingress logs show:
  - `/agent/chat/stream` request handling ~`678ms`
  - upstream model streaming call ~`2605ms`
- Approximate first visible reply behavior now in low-seconds range rather than hard failure.

## Remaining shortcomings
1. Conversation history is very long in this chat surface; prompt compaction is active and may add avoidable latency.
2. Repeated conversation/messages refresh calls are visible in network traces and may contribute to perceived slowness.

## Cleanup performed
- No dead code introduced; one packaging config change only.

## Risks
- None critical from this patch; low risk limited to packaging inclusion of existing source package.

## Acceptance criteria
- `agent-ingress` remains healthy across restarts.
- `prod_chatui` page loads.
- chat stream endpoint returns 200 and visible assistant reply.
- no `ModuleNotFoundError: integrations` in ingress logs.

## Exact verify commands
- `docker compose ps`
- `docker logs --tail=200 ghoststack-rag-agent-ingress-1`
- `python3.12 -m compileall backend/src`
- `pytest backend/tests/test_elevenlabs_hubtiger_ingress.py`
- `curl -sS -D - http://127.0.0.1/health -o /dev/null`
- `curl -sS -D - http://127.0.0.1/prod_chatui/ -o /dev/null`
