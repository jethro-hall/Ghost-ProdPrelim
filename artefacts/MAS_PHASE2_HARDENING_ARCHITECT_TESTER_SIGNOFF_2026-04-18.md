# MAS Phase 2 Hardening + Architect/Tester Signoff (2026-04-18)

## Objective

Harden GhostDASH lead/sub-agent orchestration toward production-grade MAS behavior with explicit verification from architecture and testing reviewers.

## Required Diagnostic Snapshot (before edits)

1. `git status -sb`
2. `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
3. `docker logs --tail=120 ghoststack-rag-caddy-1`
4. `docker logs --tail=120 ghoststack-rag-control-api-1`

Notes:

- Commands 3 and 4 now target the active namespaced containers used in this stack.

## Implemented Hardening

### A) Workflow-mode propagation fixed in workflow run APIs

File: `backend/src/ghostdash_api/control_api.py`

- Added `workflow_mode` into `result_json.request` for:
  - `POST /api/workflows/runs`
  - `POST /api/workflows/runs/execute`

Impact:

- Requested `workflow_mode` now persists into run records and reaches executor logic without silently falling back to `standard`.

### B) Lead-orchestrator policy tightened in stream delegation

File: `backend/src/ghostdash_api/agent_ingress.py`

- Added explicit guard: only `agent_role == "lead"` can orchestrate delegated sub-agent handoffs.
- Non-lead orchestration attempts now emit a clear failure tool event:
  - `tool_id: agent.orchestrator`
  - `blocked_reason: invalid_orchestrator_role`

### C) Delegated worker retry envelope added

File: `backend/src/ghostdash_api/agent_ingress.py`

- Added `_execute_sub_agent_with_retries(...)` wrapper around delegated sub-agent completion.
- Added attempt metadata in executed/failed worker payloads (`attempts_used`).
- Retry limit is configurable via settings.

### D) Retry configuration defaults added

File: `backend/src/ghostdash_api/settings.py`

- Added:
  - `app_sub_agent_max_retries` (default: `1`)
  - `app_sub_agent_retry_backoff_ms` (default: `300`)

## Architect + Tester Review Outcomes

### Architecture reviewer pass

- Identified and validated the key hardening areas:
  - workflow-mode propagation
  - explicit lead/sub enforcement
  - retry boundaries for delegated worker execution
- Flagged blocking sleep usage in stream path as no-go; implementation was corrected to remove blocking delay calls in orchestration retry/handoff path.

### Testing reviewer pass

- Confirmed strong coverage on:
  - workflow-mode persistence through API + executor
  - delegated worker retry semantics
- Requested one additional success-path workflow-mode assertion for completed step metadata; added.

## Regression and Verification

Executed:

- `pytest -q backend/tests/test_control_api_workflow_runs.py backend/tests/test_workflow_run_executor.py backend/tests/test_agent_ingress_prompt_hotfix.py`

Result:

- `20 passed`

Lints:

- `ReadLints` for all edited backend files: no lint errors.

## Tests Added/Updated

- Added `backend/tests/test_control_api_workflow_runs.py`
  - verifies create/execute endpoints persist requested workflow mode
  - verifies execute schedules run after persisting request payload
- Updated `backend/tests/test_workflow_run_executor.py`
  - adds explicit workflow-mode propagation assertions
  - includes runtime profile IDs for newly created agents
- Updated `backend/tests/test_agent_ingress_prompt_hotfix.py`
  - adds retry envelope unit tests for delegated sub-agent execution

## Acceptance Criteria

- `workflow_mode` is persisted and propagated from run creation/execute API to executor and step metadata.
- Lead/sub-agent orchestration only runs when selected orchestrator is a lead agent.
- Delegated sub-agent execution uses bounded retries with deterministic attempt accounting.
- Targeted regression suite passes and edited files are lint-clean.

## Exact Verify Commands

1. `cd /var/llamaindex/ghoststack-rag && git status -sb`
2. `cd /var/llamaindex && docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
3. `cd /var/llamaindex/ghoststack-rag && pytest -q backend/tests/test_control_api_workflow_runs.py backend/tests/test_workflow_run_executor.py backend/tests/test_agent_ingress_prompt_hotfix.py`
4. `cd /var/llamaindex/ghoststack-rag && python3 -m py_compile backend/src/ghostdash_api/agent_ingress.py backend/src/ghostdash_api/control_api.py`

## Human Test Engagement (required next step)

Run one lead-orchestrated finance request from chat and confirm:

1. `planned` -> `executed` sub-agent stage order appears in UI.
2. If lead is replaced with a sub-agent, orchestration fails with explicit `invalid_orchestrator_role` event.
3. Final response arrives with delegated-worker evidence included in synthesis.