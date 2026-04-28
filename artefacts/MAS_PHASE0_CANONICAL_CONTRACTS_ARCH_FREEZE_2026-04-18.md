# MAS Phase 0 - Canonical Contracts and Architecture Freeze

## Purpose

Freeze orchestration ownership and standardize run/task/tool contracts so replay and UI state become deterministic.

## Canonical Contracts Implemented

- `RunStartContract`
- `PlanGraphContract`
- `PlanTaskContract`
- `TaskDispatchContract`
- `ToolInvocationContract`
- `RunEventContract`

All contracts are implemented in `backend/src/ghostdash_api/run_contracts.py`.

## Orchestration Ownership Boundary

- Runtime edge remains at `agent_ingress`.
- Durable orchestration state is persisted via:
  - `workflow_runs`
  - `workflow_step_runs`
  - `workflow_tasks`
  - `workflow_run_events`
- Control-plane execution loop remains in `workflow_run_executor`, now event-writing and task-aware.

## Correlation / Replay Standard

- Run-level key: `run_id`
- Task-level key: `task_key = "{node_id}:{sequence}"`
- Event ordering: strict `sequence` per run.

## Acceptance Notes

- A run can now be reconstructed from `workflow_run_events`.
- UI can consume deterministic task and event timelines from run payloads.

