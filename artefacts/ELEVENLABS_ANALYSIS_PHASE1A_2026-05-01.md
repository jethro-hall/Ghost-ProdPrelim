# ElevenLabs Analysis - Phase 1A

Date: 2026-05-01  
Status: Implemented + deployed (backend contract slice) - human UI QA pending

## 1) Requirement

Start Phase 1 for a GhostDASH ElevenLabs Analysis page by delivering the contract-first backend slice:

- normalized read endpoints under `/api/*`
- cursor/list endpoint for conversations
- detail and transcript endpoints
- audio endpoint with graceful unavailable fallback
- no direct browser-to-ElevenLabs requirement

## 2) Files changed

- `backend/src/ghostdash_api/integrations/elevenlabs_analysis.py` (new)
- `backend/src/ghostdash_api/schemas.py`
- `backend/src/ghostdash_api/control_api.py`
- `backend/tests/test_elevenlabs_analysis_api.py` (new)

## 3) Architecture impact

### Correct layer

- Added operator-facing analysis integration at control-plane boundary (`control-api`) using router include.
- Preserved existing GhostDASH boundaries (`/api/*` only for operator data).

### New API surface

- `GET /api/elevenlabs/analysis/conversations`
- `GET /api/elevenlabs/analysis/conversations/{conversation_id}`
- `GET /api/elevenlabs/analysis/conversations/{conversation_id}/transcript`
- `GET /api/elevenlabs/analysis/conversations/{conversation_id}/audio`
- `GET /api/elevenlabs/analysis/health`

### Response normalization

Introduced GhostDASH-owned schemas for list/detail/transcript/audio-unavailable responses to avoid raw upstream shape coupling in the UI.

### HubTiger-style degradation behavior

- Added explicit health route with `ok/ready/error_code/message` envelope.
- Added safe upstream degradation for list endpoint:
  - returns `200` with `items=[]` when ElevenLabs upstream is unavailable/unauthorized
  - includes `upstream_ready=false`, `warning_code`, and `warning_message`
- Added explicit invalid-key mapping (`elevenlabs_invalid_api_key`) instead of generic hard `502`.

## 4) Tests run

### Backend compile

```bash
python3.12 -m compileall backend/src
```

Result: passed.

### Targeted API tests

```bash
python3.12 -m pytest -q backend/tests/test_elevenlabs_analysis_api.py
```

Result:

- `5 passed, 1 warning`

## 5) Test output (key)

- List endpoint maps ElevenLabs list payload into GhostDASH normalized list contract.
- Transcript endpoint maps transcript turns and metrics.
- Missing/invalid ElevenLabs API key now produces structured degraded responses.
- Audio missing (`404`) returns structured unavailable JSON response.
- Health endpoint returns structured readiness and error code.

## 6) Manual verification steps (human)

Run in browser/operator flow once UI route is wired:

1. Open GhostDASH analysis route.
2. Load conversation list and verify search/date/status query behavior.
3. Open one conversation and verify metadata fields render.
4. Open transcript tab and validate chronological transcript rows.
5. Trigger a conversation without audio and verify safe unavailable message.

## 7) Cleanup performed

- Kept changes limited to one new integration module, schema additions, router registration, and focused tests.
- No duplicate endpoint surfaces added outside `/api/elevenlabs/analysis/*`.

## 8) Known risks

1. Endpoint auth for operator-only analysis is currently aligned with existing control-api behavior; dedicated operator auth middleware was not introduced in this slice.
2. Production currently reports `elevenlabs_invalid_api_key`; real conversation data requires a valid ElevenLabs key.
3. UI route and human-facing rendering are not implemented yet (Phase 1B).

## 9) Remote deployment verification (true domain)

Verified against `https://ghoststack.rideai.com.au`:

- `GET /api/elevenlabs/analysis/health` -> `503` with:
  - `error_code: elevenlabs_invalid_api_key`
  - `ready: false`
- `GET /api/elevenlabs/analysis/conversations?limit=1` -> `200` with:
  - `source: elevenlabs`
  - `upstream_ready: false`
  - `warning_code: elevenlabs_invalid_api_key`
  - `items: []`

## 10) Next step

Proceed to Phase 1B UI:

- add `/analysis/elevenlabs` route + list/detail shell
- wire to normalized `/api/elevenlabs/analysis/*` endpoints
- implement loading/empty/error/unavailable states
