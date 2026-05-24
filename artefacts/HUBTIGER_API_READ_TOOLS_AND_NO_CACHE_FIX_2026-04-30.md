# Hubtiger API Read-Tools + No-Cache Fix (2026-04-30)

## Requirement

Enable `/api/elevenlabs/hubtiger/tool` to accept read workflows beyond lookup-only and allow LLM callers to retry with no-cache when responses appear stale.

## Root cause

The `/api` Hubtiger integration router was hardcoded to lookup-only:

- accepted only `lookup_job`/`job_lookup`
- raised `422` for `job_retrieve`
- dropped no-cache intent from caller payload

## Correct layer

- `control-api` integration layer (`backend/src/ghostdash_api/integrations/hubtiger_elevenlabs_tool.py`)
- request schema layer (`backend/src/ghostdash_api/integrations/hubtiger_elevenlabs_schemas.py`)
- shared adapter + MCP routing layers (cache mode normalization and bypass behavior)

## Files changed

- `backend/src/ghostdash_api/integrations/hubtiger_elevenlabs_tool.py`
- `backend/src/ghostdash_api/integrations/hubtiger_elevenlabs_schemas.py`
- `backend/src/ghostdash_api/schemas.py`
- `backend/src/integrations/elevenlabs_hubtiger/router.py`
- `backend/src/ghostdash_api/hubtiger_mcp.py`
- `backend/tests/test_hubtiger_elevenlabs_tool.py`
- `backend/tests/test_hubtiger_mcp_adapter.py`
- `services/hubtiger-mcp/index.js`
- `services/hubtiger-mcp/index.test.js`
- `docs/HUBTIGER_OPERATOR_PLAYBOOK.md`
- `docs/HUBTIGER_ELEVENLABS_TOOL_SCHEMA_PROMPT_PACK.md`

## Behavior after fix

`POST /api/elevenlabs/hubtiger/tool` now accepts read functions:

- `lookup_job`
- `job_search`
- `job_retrieve`
- `booking_availability`
- `quote_preview`

Per-request cache hint supported:

- `cache_mode: "no_cache"` (plus aliases) -> read cache bypass for that call

## Human how-to (difficult-mode)

1. Run read call normally.
2. If stale/empty-suspicious, retry same call with `cache_mode: "no_cache"`.
3. If still unavailable, provide one concrete fallback action.

Common issue triggers:

- just-sent customer update not reflected yet
- ambiguous common-name search returns stale/empty state
- availability right after booking/reschedule appears old
- quote preview appears stale after line updates

## Tests run

```bash
python3.12 -m pytest tests/test_hubtiger_elevenlabs_tool.py tests/test_hubtiger_mcp_adapter.py
```

Result:

- `16 passed, 1 warning`

```bash
cd /var/llamaindex/ghoststack-rag/services/hubtiger-mcp && npm install && node --test index.test.js
```

Result:

- `9 passed, 0 failed`

## Verify commands

```bash
curl -i -sS -X POST "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \
  -d '{"function":"job_retrieve","store":"southport","payload":{"job_card_no":"#35872"}}'

curl -i -sS -X POST "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \
  -d '{"function":"job_retrieve","store":"southport","cache_mode":"no_cache","payload":{"job_card_no":"#35872"}}'
```

## Risks

- Production must run this updated control-api build; older deployments still return lookup-only 422.
- No-cache retries increase upstream load if overused; use once per suspicious read and then fallback.
