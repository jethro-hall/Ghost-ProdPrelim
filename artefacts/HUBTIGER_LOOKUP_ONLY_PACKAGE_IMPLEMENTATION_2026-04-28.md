# HubTiger Lookup-Only Package Implementation (2026-04-28)

## Requirement Summary

Implement lookup-only ElevenLabs HubTiger package into GhostDASH backend with public `/api/elevenlabs/hubtiger/*` routes, deploy, and prove no-404 plus auth behavior and safe outputs.

## Files Changed

- `backend/src/ghostdash_api/integrations/__init__.py`
- `backend/src/ghostdash_api/integrations/hubtiger_elevenlabs_schemas.py`
- `backend/src/ghostdash_api/integrations/hubtiger_elevenlabs_tool.py`
- `backend/src/ghostdash_api/control_api.py`
- `.env`
- `backend/tests/test_hubtiger_elevenlabs_tool.py`

## Architecture Impact

- Added new lookup-only API router mounted in `control-api` (the `/api/*` owner).
- Added `GET /api/elevenlabs/hubtiger/health`.
- Added lookup-only `POST /api/elevenlabs/hubtiger/tool`.
- Removed prior duplicate `/api/elevenlabs/hubtiger/tool` handler from `control_api.py` to avoid route conflict.
- Caddy `/api/* -> control-api:8000` path remains canonical and unchanged.

## Env Applied

- `ELEVENLABS_HUBTIGER_WEBHOOK_SECRET` rotated.
- `HUBTIGER_TOOL_ACCESS=read_only`
- `HUBTIGER_MCP_URL=http://hubtiger-mcp:8000`
- `HUBTIGER_READ_TIMEOUT_MS=2500`
- `HUBTIGER_MAX_ROWS=5`
- `HUBTIGER_MAX_FIELD_CHARS=600`

## Verification Performed

1. `curl -i https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/health`
   - Result: `401` (route exists, not `404`).
2. Authenticated health with voice key
   - Result: `503` (route exists, upstream not ready at configured MCP URL).
3. Lookup smoke:
   - `POST /api/elevenlabs/hubtiger/tool` with `{"function":"lookup_job","phone":"0435185134"}`
   - Result: `200` + safe unavailable message; no internal leak fields.
4. Tests:
   - `PYTHONPATH=src pytest tests/test_hubtiger_elevenlabs_tool.py -q`
   - Result: `3 passed`.

## Leakage Check

Smoke response does not expose:

- MCP/proxy URLs
- tokens/secrets
- trace internals
- stack traces
- raw backend error strings

## Known Risk

- Requested MCP URL (`http://hubtiger-mcp:8000`) is not currently reachable in this runtime, so authenticated health reports not ready (`503`) and lookup returns safe unavailable.
- Once the `hubtiger-mcp` service is available at that address, health/lookup should move to ready/success without API contract changes.
