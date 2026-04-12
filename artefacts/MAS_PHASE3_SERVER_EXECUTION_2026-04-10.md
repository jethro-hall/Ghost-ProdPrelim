# MAS Phase 3: Backend-Owned Execution

## Goal

Move MAS execution ownership from the browser into `control-api` so Ghost ChatUI becomes a client of orchestration state rather than the orchestrator itself.

## Problem Addressed

Phase 2 persisted workflow runs, but Ghost ChatUI still:

- created the run
- progressed each step itself
- wrote step completion state directly
- effectively acted as the workflow engine

That design was too fragile because closing or interrupting the browser tab put orchestration correctness at risk.

## What Changed

### Backend

- Added `backend/src/ghostdash_api/workflow_run_executor.py`
- `control-api` now:
  - seeds executor recovery state on startup
  - marks interrupted queued/running runs as failed on restart
  - creates workflow runs with request config stored in `result_json.request`
  - exposes `POST /api/workflows/runs/execute`
  - exposes `POST /api/workflows/runs/{run_id}/cancel`
  - schedules MAS execution in-process
  - calls existing `agent-ingress /agent/chat` per selected agent
  - updates step/run persistence itself

### Frontend

- Ghost ChatUI now:
  - calls execute once
  - polls `GET /api/workflows/runs/{run_id}`
  - renders assistant outputs from persisted step state
  - uses backend cancel instead of client-side step mutation

## Execution Model

1. UI posts one execute request.
2. `control-api` creates the run and step rows.
3. `control-api` schedules async execution.
4. For each selected agent:
   - mark step `running`
   - call `/agent/chat`
   - persist answer, citations, conversation id, usage metadata
   - roll up run status
5. UI polls and reflects persisted status.
6. If the user stops the consult, the backend marks the run `aborted`.

## Why This Is Better

- Browser no longer owns workflow correctness.
- Persisted run state becomes the single source of truth.
- Cancel semantics are real backend semantics, not local UI-only state.
- The design is closer to future retry/replay without discarding current work.

## Known Constraint

- Execution is server-owned, but still in-process inside `control-api`.
- If `control-api` restarts mid-run, startup recovery currently marks interrupted runs failed rather than replaying them.
- A later slice should move scheduling/execution into a more durable job runner if resumability becomes critical.

## Acceptance Criteria

- Starting a MAS consult creates one persisted run and server-owned step progression.
- UI no longer writes step completion state directly.
- Completed runs show `completed_agents` and `failed_agents`.
- Cancelled runs are marked `aborted` and remain visible in history.
- Restarted control plane does not leave queued/running runs stuck forever.

## Verification

Backend tests:

```bash
cd /var/llamaindex/ghoststack-rag
pytest backend/tests/test_workflow_run_executor.py backend/tests/test_workflow_runs.py backend/tests/test_runtime_profiles.py backend/tests/test_workflow_runtime_recovery.py
```

Ghost ChatUI type-check:

```bash
cd /var/Ghost-chatUI
npm run lint
```

Live API check:

```bash
cd /var/llamaindex/ghoststack-rag
curl -sS https://ghoststack.rideai.com.au/api/workflows/runs?surface=ghost_chatui
```

Live HTTP check:

```bash
cd /var/llamaindex/ghoststack-rag
curl -sS -o /dev/null -w '%{http_code}\n' https://ghoststack.rideai.com.au/ghost_chatui/
```

## Human Test Results

Completed consult:

- Prompt: `Return only the token MAS_SERVER_EXEC_OK and nothing else.`
- Result: completed
- API evidence:
  - run id `d1008878-2ef4-4b63-8987-16df5b8d779a`
  - `status: completed`
  - `completed_agents: 3`
  - `failed_agents: 0`

Cancelled consult:

- Prompt: long multi-section strategy memo request
- Action: clicked `Stop generating` immediately after start
- Result: aborted
- API evidence:
  - run id `601bafb2-876a-4b7c-8592-4802cb51ace1`
  - `status: aborted`
  - `error_message: Workflow aborted by user.`
  - `step_counts.aborted: 3`
