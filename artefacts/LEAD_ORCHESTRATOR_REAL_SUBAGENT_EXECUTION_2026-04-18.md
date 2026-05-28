# Lead Orchestrator Real Sub-Agent Execution (2026-04-18)

## Objective

Move GhostDASH from simulated multi-agent handoff traces to true lead-orchestrated sub-agent execution, aligned with Cursor-like interaction expectations:

- Lead orchestrator delegates to configured sub-agents.
- Each sub-agent runs with its own runtime profile and model settings.
- UI receives visible staged events (`planned` -> `executed`/`failed`) while work is in progress.
- Final synthesis is informed by real sub-agent outputs.

## Diagnosis Evidence (captured first)

1. `git status -sb`
   - Repository is dirty with existing ongoing work (many modified/untracked files).
2. `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
   - Active services include `ghoststack-rag-agent-ingress-1`, `ghoststack-rag-control-api-1`, `ghoststack-rag-workflow-runtime-1`.
3. `docker logs --tail=120 ghoststack-rag-caddy-1`
   - Edge gateway equivalent in this repo/runtime.
4. `docker logs --tail=120 ghoststack-rag-control-api-1`
   - Active control-plane API container in this repo/runtime.

## Root Problem

The stream path used synthetic handoff events rather than true delegated execution. The UI looked orchestrated, but sub-agent reasoning was not actually executed per-stage.

## Implementation

### 1) Replaced simulated handoff with real delegation primitives

File: `backend/src/ghostdash_api/agent_ingress.py`

- Added sub-agent resolution and role classification:
  - `_classify_sub_agent_role(...)`
  - `_resolve_orchestration_sub_agents(...)`
- Added real worker prompt + execution functions:
  - `_build_worker_prompt(...)`
  - `_run_sub_agent_completion(...)`
- Added final prompt enrichment:
  - `_augment_prompt_with_worker_outputs(...)`

### 2) Streaming path now runs actual sub-agents

In `agent_chat_stream` internal `_stream()`:

- On worker-routed turns, the lead resolves real sub-agents under `parent_agent_id == lead.id`.
- Emits `planned` event per worker.
- Waits briefly (`MULTI_AGENT_HANDOFF_DELAY_SECONDS`) to show in-flight state.
- Executes each sub-agent using the worker's runtime profile and model settings.
- Emits `executed` with output excerpt (or `failed` with error payload).
- Accumulates worker outputs and injects them into the final lead synthesis prompt.

Result: visible orchestration stages are now backed by real delegated execution.

## Fit-for-Purpose Notes

- Delegation now depends on explicit lead/sub hierarchy in agent configuration.
- Worker outputs are treated as authoritative handoff material in final synthesis.
- If no sub-agents are configured under the lead, stream emits a clear orchestrator failure event (`no_sub_agents_configured`) rather than pretending delegation occurred.

## Regression Check

Executed:

- `pytest -q backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_agent_ingress_model_fallback.py`

Result:

- `18 passed`

Lints:

- `ReadLints` for `backend/src/ghostdash_api/agent_ingress.py`: no issues.

## Acceptance Criteria

- Worker-routed requests emit visible `planned` then `executed`/`failed` events for real sub-agent runs.
- Final response reflects delegated sub-agent outputs (not synthetic-only trace data).
- Missing hierarchy is explicit via orchestrator failure event, not silent fallback.
- Existing prompt hotfix + model fallback tests remain green.

## Exact Verify Commands

1. Backend regression:
   - `cd /var/llamaindex/ghoststack-rag && pytest -q backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_agent_ingress_model_fallback.py`
2. Runtime container truth:
   - `cd /var/llamaindex && docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
3. Human workflow validation (chat stream):
   - Ask lead agent for last-month finance + Shopify + marketing + entity breakdown.
   - Confirm staged cards appear in order:
     - `planned` (finance worker)
     - `executed` (finance worker)
     - `planned` (documenter worker)
     - `executed` (documenter worker)
   - Confirm final answer arrives after those stages and includes delegated synthesis.

