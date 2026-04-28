# Odoo MAS v2 Human E2E Scorecard

Date: 2026-04-23
Scope: Finance Agent chat path and GhostDASH dashboard parity
Environment: `https://ghoststack.rideai.com.au`

## Summary score

- Overall score: **9.1 / 10**
- Status: **Pass (production-acceptable)**

Scoring weights:

- 35% API correctness
- 35% Human chat flow behavior
- 20% Dashboard/operator UX parity
- 10% Stability/regression safety

## What was tested

1. API retirement and MAS behavior
2. Finance Agent run in `ghost_chatui` (human-style interaction)
3. Dashboard pages (`/tools`, `/agent`) for retirement UX
4. Regression safety after bug fix

## Results

### 1) API retirement and MAS behavior — **10/10**

- `GET /api/tools/catalog` returns `[]`
- `POST /api/odoo/mas/answer` returns deterministic comparative output
- ROAS is explicitly marked unavailable when non-deterministic
- NET caveat remains fail-closed

Verdict: PASS

### 2) Finance Agent in Ghost ChatUI — **9/10**

Observed initially:

- Provider/runtime failure surfaced in UI.
- Root cause was not provider credentials; it was an unhandled backend edge path in agent ingress tool execution:
  - `IndexError` when readiness summary list is empty after legacy tool retirement.

Fix applied:

- Patched `backend/src/ghostdash_api/tool_registry.py` to gracefully handle empty readiness summaries and return blocked tool response instead of crashing.
- Added regression test in `backend/tests/test_tools_api.py`.

After fixes:

- Finance Agent responses complete in UI (no 500 crash).
- Finance Agent finance operations now route to MAS v2 internally and return deterministic GP comparisons.
- Human browser run confirms banner and evidence:
  - `ODOO EXECUTED`
  - `Executed via Odoo MAS v2 pipeline.`

Verdict: PASS

### 3) Dashboard/operator UX parity — **8/10**

- Fresh navigation to `/tools` shows correct retirement notice:
  - "Legacy Odoo connector retired"
  - references `/api/odoo/mas/answer`
- `/agent` remains operational and reflects runtime profile state.

Residual caveat:

- Some long-lived browser sessions can display stale UI state until a fresh navigation/tab.

Verdict: PASS with cache/session caveat

### 4) Stability/regression safety — **9/10**

- Backend compile: pass
- Targeted tests: pass
- Full backend tests: pass (`210 passed`)
- New regression coverage added for retired-catalog readiness edge case

Verdict: PASS

## Key finding that was fixed during this run

- **Bug**: agent ingress crashed in Finance Agent flows when `execute_tool_operation_for_agent()` indexed readiness list `[0]` while legacy public Odoo catalog is hidden.
- **Impact**: Ghost ChatUI surfaced provider error and conversation stayed `0 msg`.
- **Fix**: return blocked response with explicit reason (`legacy_odoo_public_surface_retired`) when readiness list is empty.

## Final routing fix applied

- Added Finance Agent MAS reroute in `backend/src/ghostdash_api/agent_ingress.py`:
  - Finance Agent + `odoo.finance.*` tool plans execute via `run_odoo_mas_pipeline(...)` instead of legacy tool calls.
  - Tool events remain consistent for chat evidence (`tool_id=odoo_primary`) while execution truth records `evidence_source_mode=odoo_mas_v2`.
- Added regression test:
  - `backend/tests/test_agent_ingress_prompt_hotfix.py::test_prepare_tool_evidence_routes_finance_agent_to_odoo_mas_pipeline`

## Remaining gap

- Route decision metadata still labels operation as legacy finance helper names, while execution now happens via MAS v2 under the hood.
- This is cosmetic/telemetry debt, not a correctness blocker.

## Evidence commands

- `curl -sS https://ghoststack.rideai.com.au/api/tools/catalog`
- `curl -sS -X POST https://ghoststack.rideai.com.au/api/odoo/mas/answer -H 'Content-Type: application/json' -d '{"message":"Using Odoo only, compare GP for Brisbane vs Burleigh for March 2026. Include ROAS if available and clearly mark unavailable if not deterministic."}'`
- `curl -sS -X POST https://ghoststack.rideai.com.au/agent/chat -H 'Content-Type: application/json' -d '{"message":"Using Odoo only, compare GP for Brisbane vs Burleigh for March 2026...","agent_id":"0488d744-c66c-4d0e-9a29-c68fa81ba84f","conversation_mode":"quick","workflow_mode":"standard"}'`
- `python3.12 -m compileall backend/src`
- `pytest -q`
- `pytest -q backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_tools_api.py`
