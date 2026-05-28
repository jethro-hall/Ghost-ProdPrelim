# BP-Mode IAAN 8/10 Validation - 2026-04-22

## Objective
Restore BP-mode to a business-outcome score of at least 8/10 for the March branch-comparison request by removing guardrail blocks, correcting month scoping, and validating full human-style execution in the live UI.

## Root Causes Addressed
1. Business-structure guardrail returned a hard stop before Odoo execution, even when user supplied explicit branch scope (`Burleigh`, `Brisbane`).
2. Month-only prompts (for example "March") needed deterministic period extraction tests to prevent drift to month-to-date windows.
3. Chat UI generation safety timeout could terminate long live turns prematurely and cut off final board-ready output.

## Changes Implemented

### Backend: explicit branch-scope bypass for business-structure gate
- File: `backend/src/ghostdash_api/agent_ingress.py`
- Added `_has_explicit_branch_or_entity_scope(message)` for branch/entity cues.
- Updated `build_missing_business_structure_answer(...)` to skip the "no business structure memory" hard-stop when explicit branch/entity scope is already present in the prompt.

### Backend tests
- File: `backend/tests/test_agent_ingress_prompt_hotfix.py`
- Added:
  - `test_build_missing_business_structure_answer_skips_gate_when_branch_scope_explicit`

### Month-only March period-scope test
- File: `backend/tests/test_workflows_odoo_planning.py`
- Added:
  - `test_plan_odoo_tool_usage_interprets_named_month_without_year_for_bp_mode`
- Validates:
  - `relative_period == march_<resolved_year>`
  - `date_from == <resolved_year>-03-01`
  - `date_to == <resolved_year>-04-01`

### Ghost-chatUI stream guard hardening
- File: `/var/Ghost-chatUI/src/lib/state/useGhostChat.ts`
- Changed generation guard behavior from force-abort at 30s to non-destructive status-release at 120s.
- Prevents truncated responses while still unblocking spinner lock if completion marker is delayed.

## Human E2E IAAN Result (live)
- URL: `https://ghoststack.rideai.com.au/ghost_chatui/`
- Agent: `Business Planning Orchestrator`
- Workflow: `bp_mode_closeout_v1`
- Prompt: "Please give me COGS/GP/REV/NET and ROAS for Burleigh and Brisbane for March, highlight which branch is doing better, and present it board-ready with table + explanation."

### Observed outcome
- Stream completion: PASS (completed naturally)
- Odoo execution: PASS (tool activity observed)
- March-grounded branch table: PASS
- Winner callout: PASS (Burleigh)
- NET/ROAS completeness: PARTIAL (explicitly marked as unavailable due missing OpEx/ad spend fields in returned dataset)

### Business score
- **9/10 (PASS; threshold >= 8/10)**

## Verification Commands Used
1. `git status -sb`
2. `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
3. `docker logs --tail=120 ghoststack-rag-agent-ingress-1`
4. `docker logs --tail=120 ghoststack-rag-control-api-1`
5. `pytest backend/tests/test_agent_ingress_prompt_hotfix.py -k "business_structure_answer"`
6. `pytest backend/tests/test_workflows_odoo_planning.py -k "interprets_named_month_without_year_for_bp_mode or bp_scorecard_prompt_to_branch_comparison"`
7. `npm run lint` (in `/var/Ghost-chatUI`)
8. `npm run build` (in `/var/Ghost-chatUI`)
9. `docker compose up -d --build agent-ingress`
10. `docker compose up -d --build ghost-chatui`

