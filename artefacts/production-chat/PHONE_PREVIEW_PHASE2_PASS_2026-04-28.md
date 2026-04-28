# GhostDash Phone Preview Phase 2 Pass (2026-04-28)

## Scope implemented in this pass
- Added HubTiger admin console backend endpoints for status, safe tests, and recent traces.
- Added HubTiger Tools admin UI (status panel, category/mode matrix, safe test console, trace viewer).
- Enforced read-only write-test blocking for `booking_create` and `quote_add_line_item`.
- Added Phase 2-safe env settings for HubTiger MCP/proxy configuration and timeouts.

## Files changed
- `/var/llamaindex/ghoststack-rag/backend/src/ghostdash_api/settings.py`
- `/var/llamaindex/ghoststack-rag/backend/src/ghostdash_api/schemas.py`
- `/var/llamaindex/ghoststack-rag/backend/src/ghostdash_api/control_api.py`
- `/var/llamaindex/ghoststack-rag/backend/tests/test_hubtiger_admin_api.py`
- `/var/llamaindex/ghoststack-rag/backend/tests/test_tools_api.py` (compat assertion update; Odoo remains denied)
- `/var/llamaindex/ghoststack-rag/ui/src/api.ts`
- `/var/llamaindex/ghoststack-rag/ui/src/pages/ToolsPage.tsx`
- `/var/llamaindex/ghoststack-rag/.env.example`

## New endpoints
- `GET /api/hubtiger/status`
- `POST /api/hubtiger/test`
- `GET /api/hubtiger/traces`

## Safety behavior
- If `HUBTIGER_TOOL_ACCESS=read_only`, write tests are blocked:
  - `booking_create`
  - `quote_add_line_item`
- If `HUBTIGER_MCP_URL` is missing, test endpoint returns safe unconfigured status (no raw backend traces).
- Test trace summaries are stored in-memory as safe operator-facing events.

## Verify outputs captured
- `curl -i http://127.0.0.1/api/hubtiger/status`
  - `200 OK`
  - `mode=read_only`
  - `health=unconfigured` (in current environment)
  - bindings include availability, jobs, quotes, booking
- `curl -i -X POST http://127.0.0.1/api/hubtiger/test ... booking_create`
  - `200 OK`
  - `success=false`
  - `blocked=true`
  - message: write tests disabled in read-only mode
- `curl -s http://127.0.0.1/api/hubtiger/traces`
  - returns recent blocked trace entry

## Build/tests run
- Backend:
  - `cd /var/llamaindex/ghoststack-rag/backend && pytest -q tests/test_hubtiger_admin_api.py tests/test_tools_api.py`
  - result: `22 passed`
- UI:
  - `cd /var/llamaindex/ghoststack-rag/ui && npm run build -- --outDir dist-phase2`
  - result: successful build
  - note: default `npm run build` still fails due existing `ui/dist` filesystem permissions (`EACCES unlink .../ui/dist/assets/...`), unrelated to code validity.

## Human E2E checklist for your next pass
- Open GhostDash Admin -> Tools page.
- Confirm HubTiger status card shows mode/health/config flags.
- Confirm tool matrix renders category + mode + write action columns.
- Run `availability_lookup` with JSON payload and confirm safe response card appears.
- Run `booking_create` while mode is `read_only` and confirm blocked warning (no crash).
- Confirm traces section logs each run with operation/mode/success/blocked.
- Set `HUBTIGER_MCP_URL` in env and restart stack, re-run read operation test to validate configured path.

## Exact verify commands
- `cd /var/llamaindex/ghoststack-rag/backend && pytest -q tests/test_hubtiger_admin_api.py tests/test_tools_api.py`
- `cd /var/llamaindex/ghoststack-rag/ui && npm run build -- --outDir dist-phase2`
- `curl -sS -i http://127.0.0.1/api/hubtiger/status`
- `curl -sS -i -X POST http://127.0.0.1/api/hubtiger/test -H 'Content-Type: application/json' -d '{"operation":"booking_create","payload":{"customer_name":"Test"}}'`
- `curl -sS http://127.0.0.1/api/hubtiger/traces`
