# MAS Lead/Sub-Agent Phase 1 Implementation (2026-04-17)

## Scope Delivered

Implemented Phase 1 from `MAS_LEAD_SUBAGENT_HIERARCHY_PLAN_2026-04-17.md`:

- schema-level hierarchy support
- startup migration/backfill
- API compatibility updates on existing agent payloads
- hierarchy read endpoint

No UI hierarchy layout changes in this phase.

## Backend Changes

### Data model
- `agent_profiles` now includes:
  - `agent_role` (`lead` | `sub`)
  - `parent_agent_id` (nullable)
  - `position` (ordering integer)

### Startup migrations
- Added migration guards for new columns:
  - `agent_role`
  - `parent_agent_id`
  - `position`
- Added backfill logic:
  - defaults null/blank role to `lead`
  - defaults null/negative position to `0`
  - clears invalid parent refs
  - repairs invalid `sub` records with missing/self parent to `lead`
- Added index creation for `parent_agent_id`.

### API schema contract
- `AgentProfilePayload` now accepts:
  - `agent_role`
  - `parent_agent_id`
  - `position`
- `AgentProfileView` now returns those fields.
- Added `AgentHierarchyView`.

### Agent save validations
- Enforced:
  - `agent_role` must be `lead` or `sub`
  - `sub` requires `parent_agent_id`
  - `sub` name auto-normalizes to `[SA] ` prefix
  - `lead` cannot start with `[SA]`
  - `sub` cannot be default agent
  - parent must exist and must be `lead`
  - no self-parenting

### New endpoint
- `GET /api/agents/hierarchy`
  - returns lead agents with nested ordered sub-agents
  - legacy `GET /api/agents` remains backward-compatible

## Tests Added

- `backend/tests/test_agent_hierarchy_phase1.py`
  - sub-agent name normalization and role fields
  - parent requirement enforcement
  - hierarchy endpoint grouping

## Verification

- `pytest -q tests/test_agent_hierarchy_phase1.py tests/test_connections_and_bootstrap.py tests/test_agent_deletion_preview.py`
  - Result: `11 passed`
- Lint diagnostics for edited files: no errors.

## Next Phase

Phase 2 will implement the UI hierarchy presentation:

- left panel lead agents with indented attached sub-agents
- explicit "Add Sub-Agent" actions
- role badges and ordering controls
