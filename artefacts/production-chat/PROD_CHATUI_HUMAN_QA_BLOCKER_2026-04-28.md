# PROD ChatUI Human QA Blocker Report (2026-04-28)

## Requirement summary
- Run a full human-style QA pass on `https://ghoststack.rideai.com.au/prod_chatui/`.
- Report shortcomings, with emphasis on broken talking and slow first-reply latency.

## Test execution status
- **Blocked**: end-to-end human browser journey could not be executed from this environment due network connectivity failure to target domain.

## Evidence captured

### 1) Browser-run evidence (human-flow harness)
- Navigate `https://ghoststack.rideai.com.au/prod_chatui/` -> `chrome-error://chromewebdata/`.
- Re-test `https://ghoststack.rideai.com.au/` -> same browser error.
- Control test `https://example.com/` loaded successfully, confirming browser harness itself is functional.

### 2) Shell connectivity evidence
- `curl -I https://ghoststack.rideai.com.au/prod_chatui/` -> connection refused.
- `curl -I https://ghoststack.rideai.com.au/` -> connection refused.
- `nc -vz ghoststack.rideai.com.au 443` -> connection refused.
- DNS resolves: `ghoststack.rideai.com.au -> 15.134.161.85`.

### 3) Runtime health evidence (local stack)
- `docker compose ps` shows `agent-ingress` restarting/unhealthy.
- `docker logs ghoststack-rag-agent-ingress-1` repeats:
  - `ModuleNotFoundError: No module named 'integrations'`
- `control-api` healthy.
- `ghost-chatui` serves static assets when reached through internal network.

## Shortcomings identified
1. **Critical** - Public route was unreachable from this QA environment, preventing human validation of load/chat/voice/latency behavior.
2. **Critical** - `agent-ingress` is crash-looping (`ModuleNotFoundError: integrations`), which explains non-working talking/chat API behavior.
3. **High** - Edge dependency chain (`caddy` depends on healthy `agent-ingress`) reduces resilience; chat ingress failure can block edge bring-up and full-path testing.
4. **Medium** - Local naming/diagnostic drift (`ghost-edge-gateway`/`ghost-control-plane` not matching running container names) slows ops diagnosis.

## Root-cause snapshot
- **Primary functional break**: `agent-ingress` import failure at startup.
- **Primary QA blocker**: no TCP connectivity from this environment to `ghoststack.rideai.com.au:443`.

## Human QA checklist status
- Navigation clarity: **blocked**
- Create/edit/send flow: **blocked**
- Loading/error state quality: **blocked**
- Voice/talking controls: **blocked**
- First reply latency measurement: **blocked**
- Responsive behavior (desktop/mobile): **blocked**

## Fix list to execute next
1. Restore `agent-ingress` runtime import path for `integrations.elevenlabs_hubtiger.router`.
2. Rebuild and restart `agent-ingress`, then verify healthy state.
3. Validate Caddy + ingress full path and then rerun browser human QA on `prod_chatui`.
4. Add first-token and full-response latency instrumentation on `/agent/chat` and `/agent/chat/stream` if not already emitted.

## Acceptance criteria for next pass
- `https://ghoststack.rideai.com.au/prod_chatui/` loads consistently.
- Sending chat message returns a first token within acceptable SLA.
- Voice/talking action succeeds (or returns actionable user-safe error).
- No crash loops in `agent-ingress`.

## Exact verify commands
- `docker compose ps`
- `docker logs --tail=200 ghoststack-rag-agent-ingress-1`
- `docker compose up -d caddy agent-ingress`
- `curl -I https://ghoststack.rideai.com.au/prod_chatui/`
- `curl -sS -D - https://ghoststack.rideai.com.au/health -o /dev/null`

