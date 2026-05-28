# GhostDASH Connection Test Error Mapping (2026-04-17)

## Problem

`POST /api/connections/test` returned `500 Internal Server Error` when upstream providers rejected credentials (for example OpenAI `401 invalid_api_key`).  
This made a common operator error look like a platform outage.

## Architecture Decision

- Keep provider execution logic in runtime (`test_provider_connection`).
- Map provider/network exceptions to HTTP contract at API boundary (`control_api`), where HTTP semantics belong.
- Preserve existing success payload shape (`ConnectionTestResponse`) to avoid UI contract drift.

## Error Mapping Contract

- `ValueError` -> `400` (bad request configuration)
- `httpx.TimeoutException`/`httpx.NetworkError` -> `503` (provider unreachable/timed out)
- Upstream `401`/`403` -> `401` (authentication rejected)
- Upstream `404` with `error.code=model_not_found` -> `400` (invalid model)
- Upstream `404` generic -> `502` (provider endpoint not found)
- Upstream `429` or `>=500` -> `503` (provider unavailable)
- Unknown upstream exception -> `502`

## Files Changed

- `backend/src/ghostdash_api/control_api.py`
  - Added `_map_connection_test_exception(...)`.
  - Updated `/api/connections/test` handler to catch all provider exceptions and return mapped `HTTPException`.
- `ui/src/components/RightPanel.tsx`
  - Hardened Axios error parsing in `extractApiErrorMessage(...)` so backend `detail` messages and auth/network fallbacks surface cleanly in UI.
- `backend/tests/test_connections_test_endpoint_regression.py`
  - Added regression tests for auth failure, model-not-found, network failure, and success-shape compatibility.

## Test Evidence

- Automated:
  - `pytest -q backend/tests/test_connections_test_endpoint_regression.py` -> `4 passed`
  - `pytest -q backend/tests/test_connections_test_endpoint_regression.py backend/tests/test_connections_and_bootstrap.py -k connections` -> `7 passed`
- Live stack:
  - Rebuilt `control-api` container via `docker compose up -d --build control-api`.
  - Verified endpoint now returns `401` with clear detail instead of `500`:
    - Response detail: `Connection test failed: authentication with provider was rejected.`

## UX Note

A browser-runner pass observed one UI path still showing generic `Network Error`; `RightPanel` now includes stricter Axios-path extraction and explicit fallbacks for auth/network failures.  
If generic text still persists in a local browser, inspect network response payload at `/api/connections/test` and confirm the client receives JSON `detail`.

