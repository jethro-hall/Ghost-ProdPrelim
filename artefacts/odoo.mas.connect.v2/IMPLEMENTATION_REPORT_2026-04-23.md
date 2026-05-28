# Odoo MAS Connect v2 Implementation Report

Date: 2026-04-23
Owner: Cursor implementation agent
Status: implemented with one external blocker

## Scope implemented

### 1) Discovery artifacts (Gate 1)

Created:

- `artefacts/odoo.mas.connect.v2/discovery/odoo-report-access.md`
- `artefacts/odoo.mas.connect.v2/discovery/business-unit-dimension.md`
- `artefacts/odoo.mas.connect.v2/discovery/metric-availability-matrix.md`
- `artefacts/odoo.mas.connect.v2/discovery/roas-source-decision.md`
- `artefacts/odoo.mas.connect.v2/discovery/net-definition.md`
- `artefacts/odoo.mas.connect.v2/discovery/sample-report-payloads/profit-and-loss.json`
- `artefacts/odoo.mas.connect.v2/discovery/sample-report-payloads/balance-sheet-fallback.json`
- `artefacts/odoo.mas.connect.v2/discovery/sample-report-payloads/cash-flow-fallback.json`
- `artefacts/odoo.mas.connect.v2/discovery/sample-report-payloads/aged-receivables.json`
- `artefacts/odoo.mas.connect.v2/discovery/sample-report-payloads/aged-payables.json`

Highlights:

- confirmed production access pattern is control-plane execute API
- confirmed Burleigh and Brisbane resolve independently
- documented ROAS as caveated/unsupported without deterministic spend dependency
- enforced fail-closed `NET` semantic policy

### 2) Legacy Odoo exposure retirement

Implemented:

- public tool catalog and readiness summaries now hide legacy Odoo surface in `backend/src/ghostdash_api/tool_registry.py`
- default runtime tool policy no longer includes `odoo_primary` in `backend/src/ghostdash_api/runtime_profiles.py`
- legacy policy normalization strips `odoo_primary`
- retired docs rewritten to MAS v2 canonical path:
  - `docs/AGENT_ODOO_API_REFERENCE.md`
  - `docs/ODOO_ERP_LLM_DYNAMIC_SURFACE.md`
- UI launchers removed:
  - `ui/src/components/GhostChat.tsx`
  - `ui/src/pages/chat/ChatSidebar.tsx`
  - `ui/src/hooks/useChatEngine.ts`
- tools UI replaced with retirement notice:
  - `ui/src/pages/ToolsPage.tsx`
- agent config Odoo section converted to retirement status (no toggle action):
  - `ui/src/pages/AgentConfigPage.tsx`
- seeded Odoo specialist agents removed/disabled in `backend/src/ghostdash_api/agent_memory.py`

### 3) New MAS v2 module (backend)

Created `backend/src/ghostdash_api/odoo_mas/` with:

- contracts: `contracts.py`
- registries + loader: `config/*.json`, `registry_loader.py`
- deterministic stages:
  - `router.py`
  - `planner.py`
  - `extractors.py`
  - `normalizers.py`
  - `quality_flags.py`
  - `assembler.py`
  - `reasoner.py`
  - `composer.py`
  - `pipeline.py`
- support modules:
  - `cache.py`
  - `observability.py`
- package export: `__init__.py`

### 4) Runtime/API integration

Added MAS v2 API endpoint:

- `POST /api/odoo/mas/answer` in `backend/src/ghostdash_api/control_api.py`

### 5) Test hardening

Added tests:

- `backend/tests/test_odoo_mas_pipeline.py`
- `backend/tests/test_control_api_odoo_mas.py`

Updated tests for retired legacy tool exposure behavior:

- `backend/tests/test_agent_ingress_prompt_hotfix.py`
- `backend/tests/test_tools_api.py`

## Validation evidence

### Build and tests

- `python3.12 -m compileall backend/src` -> pass
- `pytest -q` (backend) -> pass (`208 passed`)
- UI lint/build in node container -> pass
  - `pnpm run lint`
  - `pnpm run build`

### Runtime diagnostics

- `git status -sb` captured
- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'` captured
- logs captured:
  - `docker logs --tail=120 ghoststack-rag-agent-ingress-1`
  - `docker logs --tail=120 ghoststack-rag-control-api-1`
  - `docker logs --tail=120 ghoststack-rag-workflow-runtime-1`
- `docker compose config` -> pass

## Human E2E status

Attempted browser-driven human-style validation through available browser automation channel.

Blocker:

- browser automation request failed due external billing/invoice lock before interaction could start.

Impact:

- automated human-style page walkthrough evidence could not be captured in this run.

Required final manual checks (operator handoff):

1. Open `https://ghoststack.rideai.com.au/ghost_chatui/`.
2. Confirm no "New Odoo Specialist" or "New Odoo Operations" workflow launchers.
3. Confirm Agent Config Odoo area is retirement messaging only (no active toggle).
4. Confirm Tools page shows legacy retirement notice and references `/api/odoo/mas/answer`.
5. Run Burleigh vs Brisbane finance request and confirm output uses MAS v2 behavior with NET/ROAS caveats as configured.

## Rerun evidence (U6/U7 repeated on request)

Date: 2026-04-23 (rerun pass)

### U6 hardening rerun

- `python3.12 -m compileall backend/src` -> pass
- `pytest -q` -> pass (`208 passed, 3 warnings`)
- `docker compose config` -> pass
- UI lint/build in container -> pass
  - `corepack enable && corepack prepare pnpm@9.15.0 --activate`
  - `pnpm install --frozen-lockfile`
  - `pnpm run lint`
  - `pnpm run build`

### U7 human-style browser rerun

#### 1) Live endpoint checks (post-redeploy)

- `curl -sS https://ghoststack.rideai.com.au/api/tools/catalog` -> `[]`
- `POST https://ghoststack.rideai.com.au/api/odoo/mas/answer` -> `200` with successful deterministic payload.
- MAS payload confirmed:
  - Burleigh vs Brisbane gross profit comparison returned
  - ROAS returned as unavailable (`null`) with explicit caveats
  - NET caveat explicitly present as blocked pending approved definition

#### 2) Ghost ChatUI test (`/ghost_chatui`) using Finance Agent only

Actions:

- selected `Finance Agent` lead profile
- started a new Finance Agent conversation
- submitted: "Using Odoo only, compare GP for Brisbane vs Burleigh for March 2026. Include ROAS if available. If ROAS is not deterministically available, state that clearly and do not estimate."

Observed:

- UI rendered provider-side failure state: "The provider reported an error. Review the message bubble details or switch to mock mode for UI testing."
- conversation entry remained `0 msg`, indicating no completed assistant response persisted in that turn

Assessment:

- backend MAS endpoint is healthy and returns expected deterministic output
- chat surface currently has a runtime/provider integration issue for this Finance Agent flow

#### 3) Dashboard test (`/agent` and `/tools`)

Observed in live UI:

- `/tools` still renders legacy "Odoo read-only gateway" controls
- `/agent` still renders Odoo-related configuration tabs/controls in current runtime state

Assessment:

- API-level retirement behavior is active (`/api/tools/catalog` empty)
- dashboard presentation appears out of sync with intended retirement UX for this deployment

### Current blocker and requested adjustment

To complete a clean end-to-end human pass, one of the following needs your direction:

1. approve switching Finance Agent provider/model for the live chat test, or
2. approve forcing runtime profile/tool UI cache reset and redeploy for dashboard parity, or
3. provide the exact provider connection that should be pinned for Finance Agent in production.

## Final rerun closeout (after adjustments)

Date: 2026-04-23 (final closeout)

What was done:

- Applied a backend hotfix for Finance Agent chat stability:
  - file: `backend/src/ghostdash_api/tool_registry.py`
  - change: when legacy public Odoo catalog is hidden and readiness list is empty, return a blocked tool response instead of indexing `[0]`.
- Added regression test:
  - file: `backend/tests/test_tools_api.py`
  - test: `test_execute_tool_operation_for_agent_handles_retired_catalog_without_crashing`
- Re-ran compile + tests + service redeploy.

Verification:

- `python3.12 -m compileall backend/src` -> pass
- `pytest -q backend/tests/test_tools_api.py backend/tests/test_agent_ingress_prompt_hotfix.py` -> pass
- `pytest -q` -> pass (`210 passed`)
- live API:
  - `/api/tools/catalog` -> `[]`
  - `/api/odoo/mas/answer` -> `200` deterministic payload
- `/agent/chat` with Finance Agent -> `200`; returns executed tool event with `summary="Executed via Odoo MAS v2 pipeline."`

Human UI rerun:

- `ghost_chatui` with Finance Agent now completes responses (no 500 crash).
- Finance Agent now returns deterministic comparison output in chat flow via MAS v2 (Brisbane vs Burleigh GP values returned; ROAS unavailable is caveated, not fabricated).
- dashboard `/tools` shows retirement UX correctly in fresh navigation.

## Final fixc completion (Finance Agent MAS chat routing)

Date: 2026-04-23 (final fixc pass)

Applied:

- `backend/src/ghostdash_api/agent_ingress.py`
  - Added Finance Agent reroute for `odoo.finance.*` plans to execute via `run_odoo_mas_pipeline(...)`.
  - Preserved chat evidence shape while marking execution truth as `evidence_source_mode=odoo_mas_v2`.
  - Updated both `/agent/chat` and `/agent/chat/stream` call paths to provide `agent_name` for route selection.
- `backend/tests/test_agent_ingress_prompt_hotfix.py`
  - Added `test_prepare_tool_evidence_routes_finance_agent_to_odoo_mas_pipeline`.

Live validation:

- API:
  - `/api/tools/catalog` -> `[]`
  - `/agent/chat` Finance Agent request now returns:
    - `tool_events[0].status = executed`
    - `tool_events[0].summary = Executed via Odoo MAS v2 pipeline.`
    - `tool_events[0].payload.execution_truth.evidence_source_mode = odoo_mas_v2`
- Human browser (`/ghost_chatui`, Finance Agent only):
  - No provider error banner.
  - Response card displays `ODOO EXECUTED` and `Executed via Odoo MAS v2 pipeline.`
  - Finance output includes deterministic GP comparison and ROAS caveat.

Scoring artifact:

- `artefacts/odoo.mas.connect.v2/HUMAN_E2E_SCORECARD_2026-04-23.md`

## Production policy enforcement (finalized)

Date: 2026-04-23

Implemented immutable config-backed defaults in MAS v2:

- `backend/src/ghostdash_api/odoo_mas/config/policy_config.json`
  - `include_merchant_fees_in_marketing=false`
  - `include_marketing_wages_in_marketing=false`
  - `allow_blended_marketing_efficiency=true`
  - `output_sign_mode=absolute`
  - `internal_sign_mode=accounting`
- Policy is loaded via registry loader and enforced in metric assembly (not in prompts).
- Marketing spend now excludes merchant fees and marketing wages by default.
- Optional overrides are explicit-only (via `policy_overrides` payload keys).
- Board-facing monetary output for ledger-derived spend uses absolute values.

## Finance Agent forced MAS autoroute (no-plan hardening)

Date: 2026-04-23

Implemented:

- `backend/src/ghostdash_api/agent_ingress.py`
  - Added `_should_force_finance_message_to_odoo_mas(...)` guard.
  - When Finance Agent receives Odoo-finance intent and query planning returns no tool operation, `prepare_tool_evidence(...)` now auto-routes to MAS using operation `odoo.mas.intent.auto_route`.
  - This prevents direct narrative fallback from bypassing MAS evidence execution.

Tests added:

- `backend/tests/test_agent_ingress_prompt_hotfix.py`
  - `test_should_force_finance_message_to_odoo_mas_when_odoo_intent_present`
  - `test_prepare_tool_evidence_forces_mas_when_plan_is_none_for_finance_odoo_intent`

Verification:

- `pytest -q backend/tests/test_agent_ingress_prompt_hotfix.py` -> pass (`46 passed`)
- `pytest -q backend/tests/test_odoo_mas_pipeline.py` -> pass (`13 passed`)
- Live `/agent/chat` check using Finance Agent ID confirms:
  - `tool_events[0].operation = odoo.mas.intent.auto_route`
  - `tool_events[0].payload.execution_truth.evidence_source_mode = odoo_mas_v2`
  - Answer includes `Execution Truth` block rendered from MAS markdown.
