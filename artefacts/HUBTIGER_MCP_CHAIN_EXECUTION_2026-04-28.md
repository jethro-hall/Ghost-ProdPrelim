# HubTiger MCP Chain Execution (2026-04-28)

## Goal

Bring HubTiger MCP integration online so `POST /api/elevenlabs/hubtiger/tool` can execute canonical functions via a reachable MCP URL instead of returning `configured=false`.

## Runtime Architecture Executed

1. `ghoststack-rag-control-api-1` receives canonical HubTiger tool calls.
2. Control API uses `HUBTIGER_MCP_URL` to call `ghoststack-rag-hubtiger-mcp-1` on Docker network.
3. MCP calls `ghoststack-rag-hubtiger-proxy-1`.
4. Proxy forwards to `ghoststack-rag-hubtiger-service-1` (local stub backend).

## Configuration Applied

- Updated `.env`:
  - `HUBTIGER_MCP_URL=http://ghoststack-rag-hubtiger-mcp-1:8096`
- Restarted `control-api` and `agent-ingress` with compose so env is loaded.

## Code Changes Applied

- `scripts/hubtiger/hubtiger-service/index.js`
  - Added `GET /availability/technicians` stub route.
  - Added `POST /quotes/find-add` stub route.
- `scripts/hubtiger/hubtiger-proxy/index.js`
  - In non-portal mode, `GET /availability/technicians` now proxies to `HUBTIGER_BASE_URL` instead of returning 400.
  - In non-portal mode, `POST /quotes/find-add` now proxies to `HUBTIGER_BASE_URL` instead of returning 400.

## Containers Started

- `ghoststack-rag-hubtiger-service-1` (`node:20-alpine`, mounted `scripts/hubtiger/hubtiger-service`)
- `ghoststack-rag-hubtiger-proxy-1` (`local/hubtiger-proxy`)
- `ghoststack-rag-hubtiger-mcp-1` (`local/hubtiger-mcp`)

## Verification Evidence

### API Success: Job Lookup

Request:

- `function=lookup_job`
- `store=southport`
- `customer.phone=0435185134`

Result:

- HTTP `200`
- `success=true`
- `operation=job_lookup`

### API Success: Booking Availability

Request:

- `function=booking_availability`
- `store=brisbane`
- `start_date=2026-04-29`

Result:

- HTTP `200`
- `success=true`
- `operation=availability_lookup`
- data includes `technicians`, `store`, `message`.

### API Success: Quote Preview

Request:

- `function=quote_preview`
- `payload.job_id=1234`
- `payload.search=brake pads`

Result:

- HTTP `200`
- `success=true`
- `operation=quote_preview`
- data includes `dryRun=true`, quote payload echo.

## Test Notes

- Local host pytest execution is blocked by missing Python dependencies (`fastapi`) and module path in host shell.
- In-container test run was blocked because test files are not present at the runtime container path expected by `pytest`.
- Live HTTP smoke tests through Caddy and control-api were used as primary executable proof for this step.

## Human QA Hand-off Checklist

1. In GhostChat/Magic Mike flow, run these intents:
   - "Find customer job by phone 0435185134"
   - "Check Brisbane booking availability for tomorrow"
   - "Preview quote for service 1234, brake pads"
2. Confirm each response is:
   - customer-safe
   - JSON-structured at tool layer
   - no internal stack traces
3. Confirm no duplicate calls on repeated prompt submission.

## Risks / Next Hardening

- Current upstream uses local stub service, not live HubTiger portal credentials.
- For production portal mode, set `HUBTIGER_PORTAL_MODE` and required partner/auth env vars on proxy, then re-run same smoke set.

## Phase 2: Live Portal Mode Execution (Same Day)

### Runtime Change

- Re-launched `ghoststack-rag-hubtiger-proxy-1` with:
  - `HUBTIGER_PORTAL_MODE=true`
  - `HUBTIGER_PARTNER_ID` (from HAR reference)
  - `HUBTIGER_FUNCTION_CODE` (from HAR reference)
  - `HUBTIGER_LEGACY_TOKEN` (from HAR reference)

### Additional Code Change

- `backend/src/ghostdash_api/hubtiger_mcp.py`
  - Updated `_build_job_search_query` to normalize `+61...` phone values back to local `0...` format for HubTiger search compatibility.

### Phase 2 Verification

1. `lookup_job` with canonical payload (only `customer.phone`) now succeeds in portal mode.
2. `booking_availability` succeeds in portal mode and returns live technician availability rows with earliest slot selection.
3. `quote_preview` still returns upstream unavailable (`status_code=502`) in portal mode.

### Confirmed Quote Failure Root Cause

- Direct proxy call to `POST /quotes/find-add` returns:
  - `{"ok":false,"error":"product_search_failed","message":"portal_products_sync_failed"}`
- Interpretation: quote preview is blocked by upstream product catalog sync dependency in HubTiger POS lane, not by canonical function mapping.

### Security / Ops Note

- Portal credential material currently came from HAR reference for execution proof.
- Move these values into managed secrets and rotate them before production use.

## Phase 3: Best-Practice Hardening + Code Tidy

### Objectives Applied

- Deterministic-first HubTiger routing and payload shaping.
- Strict search field and result size limits.
- Optional local-LLM micro path only for oversized simple search phrases.
- Cleaned and centralized guardrail helpers to reduce drift.

### Backend Changes

- `backend/src/ghostdash_api/hubtiger_mcp.py`
  - Added operation payload allowlists.
  - Added string and search field trimming (`max_search_chars`).
  - Added defensive public data shaping with list caps and hard payload-size cap.
  - Added optional local-LLM query compaction (`hubtiger_enable_local_simple_llm`) for oversized simple text.
  - Reduced default availability window from 7 days to 2 days when `end_date` is omitted to reduce latency and payload volume.
- `backend/src/ghostdash_api/schemas.py`
  - Added request payload guardrails for canonical tool body:
    - max key count
    - max key length
    - max string value length
- `backend/src/ghostdash_api/settings.py`
  - Added configurable knobs:
    - `hubtiger_max_search_chars`
    - `hubtiger_max_rows`
    - `hubtiger_max_matches`
    - `hubtiger_max_field_chars`
    - `hubtiger_max_payload_chars`
    - `hubtiger_enable_local_simple_llm`
    - `hubtiger_simple_llm_timeout_ms`
    - `hubtiger_simple_llm_max_tokens`

### Proxy Changes

- `scripts/hubtiger/hubtiger-proxy/index.js`
  - Added `compactSearchText()` helper.
  - Capped job search query length.
  - Capped product search query length.
  - Capped job search results count.
  - Capped availability rows count.
  - Applied the same capped search logic to quote preview product lookup.

### Phase 3 Verification

1. `lookup_job` (canonical, phone-only input): success.
2. `booking_availability` (canonical): success with reduced payload size and bounded rows.
3. `quote_preview`: still blocked by upstream `portal_products_sync_failed` dependency path (same root cause as Phase 2).
