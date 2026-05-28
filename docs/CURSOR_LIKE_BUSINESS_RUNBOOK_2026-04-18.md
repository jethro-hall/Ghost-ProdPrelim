# Cursor-like Business Platform Runbook (Phase 5)

## Scope

Operational verification for durable orchestration, policy-governed tools, memory tiers, and UI timeline parity.

## Acceptance Criteria

1. New workflow run returns `steps`, `tasks`, and `events` with deterministic ordering.
2. Workflow step updates mutate corresponding task state and append timeline events.
3. Tool execution writes policy metadata (`risk_class`, `requires_approval`, `policy_decision_id`) and audit rows.
4. Memory service stores working snapshots and can build episodic snapshots from run events.
5. Right panel shows todo graph and run timeline entries for active workflow runs.

## Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag/backend && pytest -q tests/test_run_contracts.py tests/test_workflow_run_events_tasks.py tests/test_tool_registry_policy_and_audit.py tests/test_memory_service.py
```

```bash
cd /var/llamaindex/ghoststack-rag/backend && pytest -q tests/test_control_api_workflow_runs.py tests/test_workflow_run_executor.py tests/test_workflow_runs.py
```

```bash
cd /var/Ghost-chatUI && npm run lint
```

```bash
cd /var/Ghost-chatUI && npm run build
```

