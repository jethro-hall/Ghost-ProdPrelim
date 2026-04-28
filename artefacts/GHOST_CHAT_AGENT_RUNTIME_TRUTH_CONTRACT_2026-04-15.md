## Problem
GhostDASH agent behavior could drift because new agents were allowed to materialize with an implicit default runtime profile, and read paths could still seed data during normal access.

## Contract
### 1. New agents must be explicit
Creating a new agent now requires one of:
- `runtime_profile`
- `runtime_profile_id`

GhostDASH must not silently attach a hidden default runtime profile during operator-driven agent creation.

### 2. Read paths must not rewrite operator intent
`list_agents()` and `get_agent()` no longer seed or rewrite agent/runtime state during ordinary reads.

Seeding remains a startup/bootstrap concern only:
- `control_api.initialize_control_runtime_state()`
- `agent_ingress.initialize_agent_runtime_state()`

### 3. Runtime profile is the source of truth
At runtime, the effective chat behavior comes from the resolved runtime profile attached to the selected agent:
- prompt
- model
- corpora defaults
- tool policy

### 4. Tool policy semantics
- `kb`: must explicitly gate retrieval behavior
- `web`: requires enablement plus valid allowlisted URLs plus explicit use/intent
- `odoo_primary`: requires enablement plus healthy registry readiness plus session allowance

## Repair details
Files changed:
- `backend/src/ghostdash_api/agent_memory.py`
- `backend/src/ghostdash_api/runtime_profiles.py`
- `backend/src/ghostdash_api/workflows.py`

Behavior changes:
- new agents without explicit runtime config now fail fast with a clear error
- message history no longer depends on hidden default profile assignment
- planner/retrieval receives active runtime KB state instead of always consulting the default runtime profile

## Acceptance criteria
1. Creating a new agent without runtime config fails clearly.
2. Reading agents does not mutate operator-owned runtime config.
3. Planner/retrieval uses the active agent runtime KB settings, not the default runtime profile by accident.

## Verify
```bash
pytest backend/tests/test_runtime_profiles.py backend/tests/test_connections_and_bootstrap.py -q
```

