# MAS Phase 4: Head-Agent + JSON/YAML Definitions

Date: 2026-04-10

## Goal

Move the existing MAS implementation from "persisted sequential multi-agent runs" to a more explicit head-agent orchestration model that is:

- visible in the Ghost ChatUI UI
- programmable through workflow definitions
- exportable/importable as JSON or YAML
- stricter about preserving user output constraints

## What Changed

### Backend

- Added first-class workflow definition API support:
  - `GET /api/workflows/definitions`
  - `GET /api/workflows/definitions/{workflow_id}`
  - `POST /api/workflows/definitions`
  - `POST /api/workflows/definitions/import`
  - `GET /api/workflows/definitions/{workflow_id}/export?format=json|yaml`
- Added `workflow_definition_io.py` for JSON/YAML parsing and export.
- Extended the MAS definition contract to support:
  - `child_agent` nodes
  - `head_agent_synthesis` nodes
  - `head_agent` configuration
- Updated the seeded default workflow definition:
  - `workflow_id: mas_consult_v1`
  - `name: Head-Agent MAS Consult`
- Extended workflow run creation so a run can materialize:
  - one step per selected child agent
  - a final head-agent synthesis step
- Extended workflow summaries to expose:
  - `workflow_name`
  - `head_agent_id`
  - `head_agent_name`
- Hardened the head-agent prompt so strict-output requests are preserved exactly.

### Frontend

- Ghost ChatUI now treats the active agent as the MAS head agent.
- The right panel now shows:
  - `Head Agent`
  - the workflow name
  - `Definition ID`
  - JSON/YAML programmability messaging
- The active agent is visually reserved as head agent and cannot be selected as a child agent.
- Persisted run cards now show:
  - workflow name
  - head-agent label
  - final `Head synthesis` step
- Active run step labels were adjusted for readability.

## Runtime Model

1. User picks an active agent.
2. Active agent becomes the head agent for MAS.
3. User selects 2-3 child agents.
4. Backend creates a persisted run from the workflow definition.
5. Backend executes child-agent steps sequentially.
6. Backend executes a final head-agent synthesis step using the child outputs.
7. Ghost ChatUI polls and renders the persisted run state.

## Acceptance Criteria

- The live workflow definitions API returns the seeded head-agent workflow.
- The live YAML export returns the same workflow contract.
- Ghost ChatUI visibly shows the head-agent MAS UI.
- The head agent is not selectable as a child agent.
- A real live MAS run completes with a final `Head synthesis` step.
- Strict-output prompts are preserved by the final head-agent response.

## Verification Commands

```bash
cd /var/llamaindex/ghoststack-rag
pytest backend/tests/test_workflow_runs.py backend/tests/test_workflow_run_executor.py
```

```bash
cd /var/Ghost-chatUI
npm run lint
```

```bash
cd /var/llamaindex/ghoststack-rag
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

```bash
cd /var/llamaindex/ghoststack-rag
curl -fsS https://ghoststack.rideai.com.au/api/workflows/definitions | python3 -m json.tool
```

```bash
cd /var/llamaindex/ghoststack-rag
curl -fsS "https://ghoststack.rideai.com.au/api/workflows/definitions/mas_consult_v1/export?format=yaml"
```

## Human Test Result

Live browser verification passed after deployment.

Prompt used:

```text
Return only the token MAS_HEAD_AGENT_OK and nothing else.
```

Observed final visible response:

```text
MAS_HEAD_AGENT_OK
```

Observed live UI labels included:

- `Current workflow: Head-Agent MAS Consult`
- `Definition ID: mas_consult_v1`
- `Head Agent`
- `Head synthesis`

## Notes

- The system is now definition-driven, but still sequential.
- The next sensible extension is workflow selection/import from the UI, not just via API.
- Another strong next step is retry/replay from persisted runs using the same stored definition and request envelope.
