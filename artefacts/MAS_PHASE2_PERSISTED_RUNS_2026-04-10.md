# MAS Phase 2: Persisted Workflow Runs

## Goal

Persist Ghost ChatUI multi-agent consults as first-class workflow runs inside the existing GhostDASH control plane, without introducing a separate orchestration service.

## Scope

- Persist one workflow run per MAS consult.
- Persist one child step run per selected agent.
- Keep the existing sequential consult execution in Ghost ChatUI.
- Expose recent workflow run history over `control-api`.
- Show active and recent MAS runs in Ghost ChatUI.

## Non-goals

- No new backend worker or orchestration runtime.
- No replay or retry executor yet.
- No cancellation propagation into provider streams beyond marking the persisted run as aborted.
- No YAML import/export endpoint in this slice; JSON remains the canonical runtime store.

## Data Model

### `workflow_definitions`

- `workflow_id`
- `version`
- `name`
- `execution_mode`
- `definition_json`
- `enabled`

Current seeded definition:

- `mas_consult_v1`

### `workflow_runs`

- `workflow_definition_id`
- `workflow_id`
- `surface`
- `execution_mode`
- `status`
- `current_step`
- `progress`
- `prompt`
- `requested_agent_ids_json`
- `parent_conversation_id`
- `result_json`
- `error_message`
- `started_at`
- `completed_at`

### `workflow_step_runs`

- `run_id`
- `sequence`
- `node_id`
- `node_type`
- `status`
- `agent_id`
- `agent_name`
- `conversation_id`
- `output_text`
- `citations_json`
- `error_message`
- `metadata_json`
- `started_at`
- `completed_at`

## Status Model

Run statuses:

- `queued`
- `running`
- `completed`
- `completed_with_errors`
- `failed`
- `aborted`

Step statuses:

- `pending`
- `running`
- `completed`
- `failed`
- `aborted`

## Control API Contract

### Create run

- `POST /api/workflows/runs`

Payload:

```json
{
  "workflow_id": "mas_consult_v1",
  "surface": "ghost_chatui",
  "prompt": "Compare the operational risks and delivery tradeoffs.",
  "agent_ids": ["agent-a", "agent-b"],
  "parent_conversation_id": "optional-parent-thread"
}
```

### Update run

- `POST /api/workflows/runs/{run_id}`

Payload fields:

- `status`
- `error_message`
- `result_json`

### Update step

- `POST /api/workflows/runs/{run_id}/steps/{step_id}`

Payload fields:

- `status`
- `conversation_id`
- `output_text`
- `citations`
- `error_message`
- `metadata_json`

### Read history

- `GET /api/workflows/runs?surface=ghost_chatui`
- `GET /api/workflows/runs/{run_id}`

## Execution Flow

1. Ghost ChatUI creates a workflow run before the first agent stream starts.
2. Ghost ChatUI marks each step `running` immediately before that agent is consulted.
3. On stream completion, Ghost ChatUI stores:
   - child `conversation_id`
   - final `output_text`
   - `citations`
   - terminal step status
4. The backend rolls up run progress and status after each step mutation.
5. Ghost ChatUI updates the right panel using the returned run payload and keeps recent run summaries in memory.
6. If the user stops generation, the persisted run is marked `aborted`.

## Why This Design

- Fits the current stack with minimal operational risk.
- Gives auditable MAS history immediately.
- Keeps the existing live streaming path intact.
- Leaves room for future server-side execution and replay without discarding the new data model.

## Acceptance Criteria

- A MAS consult creates a row in `workflow_runs`.
- Selected agents create ordered rows in `workflow_step_runs`.
- Step updates roll up run progress and status correctly.
- Ghost ChatUI shows active run status and recent persisted history.
- Aborted consults are recorded as aborted instead of disappearing.

## Verification Commands

Backend regression tests:

```bash
cd /var/llamaindex/ghoststack-rag
pytest backend/tests/test_workflow_runs.py backend/tests/test_runtime_profiles.py backend/tests/test_workflow_runtime_recovery.py
```

Ghost ChatUI type-check:

```bash
cd /var/Ghost-chatUI
npm run lint
```

Workflow runs API smoke check:

```bash
cd /var/llamaindex/ghoststack-rag
curl -sS https://ghoststack.rideai.com.au/api/workflows/runs?surface=ghost_chatui
```

Ghost ChatUI availability check:

```bash
cd /var/llamaindex/ghoststack-rag
curl -sS -o /dev/null -w '%{http_code}\n' https://ghoststack.rideai.com.au/ghost_chatui/
```

## Known Gaps

- Host-side `npm run build` for `Ghost ChatUI` still hits the optional native Tailwind binding issue on this machine. Docker deployment remains the reliable production path.
- Existing unrelated TypeScript issues remain in the GhostDASH UI app and were not introduced by this slice.
