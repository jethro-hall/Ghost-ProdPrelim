# Hubtiger Execute Path Fix

Date: 2026-04-29

## Requirement

Make Hubtiger execution truthful and deterministic:

- booking and quote writes must use the real MCP/proxy execute path
- unsupported operations must fail clearly
- product-facing names must match what the backend actually supports

## Root Cause

Before this change:

- `booking_create` and `quote_add_line_item` did not get explicit execute mappings in `backend/src/ghostdash_api/hubtiger_mcp.py`
- the Node MCP service defaulted unsupported `/test` requests to `jobs/search`
- prompt/UI names had drifted away from the canonical supported Hubtiger surface

That produced the worst possible behavior: some write-style requests looked integrated but could degrade into the wrong operation instead of failing clearly.

## Files Changed

- `backend/src/ghostdash_api/hubtiger_mcp.py`
- `services/hubtiger-mcp/index.js`
- `services/hubtiger-mcp/index.test.js`
- `backend/src/ghostdash_api/magic_mike.py`
- `backend/src/ghostdash_api/control_api.py`
- `ui/src/pages/AgentConfigPage.tsx`
- `backend/tests/test_hubtiger_mcp_adapter.py`
- `backend/tests/test_hubtiger_admin_api.py`

## What Changed

### Execution mapping

- Added explicit Python execute mapping for:
  - `booking_create` -> `POST /bookings`
  - `quote_add_line_item` -> `POST /quotes/find-add` with `dryRun: false`
- Added matching Node MCP mapping for those same operations.
- Changed MCP `/test` to return an explicit `unsupported_hubtiger_test_operation` error instead of silently defaulting to `jobs/search`.

### Truth alignment

- Added alias normalization for the `hubtiger_*` names already used by control-plane and prompt surfaces.
- Removed stale unsupported Hubtiger tool names from Magic Mike’s prompt.
- Updated Agent Config HubTiger bindings summary to the aligned five-tool surface.
- Tightened the control-plane HubTiger binding label for booking availability.

## Verification

### Automated tests

Backend tests passed in isolated app image with mounted source:

```bash
docker run --rm -e PYTHONPATH=/app/src -v "/var/llamaindex/ghoststack-rag/backend:/app" ghoststack-rag-control-api \
  python -m pytest \
  tests/test_hubtiger_mcp_adapter.py \
  tests/test_hubtiger_admin_api.py \
  tests/test_elevenlabs_hubtiger_ingress.py \
  tests/test_hubtiger_elevenlabs_tool.py
```

Result:

- `26 passed, 1 warning`

Node MCP tests passed in isolated container:

```bash
docker run --rm -v "/var/llamaindex/ghoststack-rag/services/hubtiger-mcp:/src:ro" node:20-alpine sh -lc \
  "cp -r /src /tmp/app && cd /tmp/app && npm install >/tmp/npm-install.log 2>&1 && node --test index.test.js"
```

Result:

- `3 passed`

Compose validation passed:

```bash
docker compose config
```

### Human-style / live verification

Rebuilt services:

```bash
docker compose up -d --build control-api agent-ingress hubtiger-mcp ui
```

Verified live behavior:

1. `GET /api/hubtiger/status`
   - returned the aligned bindings:
     - `hubtiger_booking_availability`
     - `hubtiger_job_lookup`
     - `hubtiger_quote_preview`
     - `hubtiger_booking_create`
     - `hubtiger_quote_add_line_item`

2. `POST /api/hubtiger/test` with `booking_create`
   - returned a clean read-only block:
   - `Write operations are disabled while HubTiger runs in read-only mode.`

3. Direct MCP `POST /test` with unsupported operation
   - returned:
   - `unsupported_hubtiger_test_operation`

4. Direct MCP `POST /test` with `booking_create`
   - returned:
   - `booking_create_only_supported_in_portal_mode`
   - this proves the request now reaches the booking path instead of silently degrading into `jobs/search`

5. Direct MCP `POST /test` with `quote_add_line_item`
   - returned a direct quote-path failure (`hubtiger_proxy_404`)
   - this proves the request is no longer falling through to `jobs/search`

6. Browser QA on live GhostDASH
   - Agent Config shows the five aligned HubTiger binding names
   - old drifted names like `hubtiger_job_get` and `hubtiger_quote_preview_price` are not present

## Remaining Constraints

The execution-path bug is fixed, but live booking/quote success is still constrained by runtime config:

- `HUBTIGER_TOOL_ACCESS=read_only`
- `HUBTIGER_PORTAL_MODE` is unset
- `HUBTIGER_PARTNER_ID` is unset
- control-plane status shows `proxy_url_configured=false`

So the current stack now fails honestly instead of failing deceptively.

## HAR Guidance

A new HAR is **not required yet**.

The current evidence shows the main bug was internal routing drift, and that is fixed. The next blocker is environment/runtime configuration for real portal-backed write success, not an unknown browser contract.

Request a new HAR only if, after enabling the required HubTiger portal/runtime settings, live booking or quote writes still return payload-shape errors from the proxy/upstream.
