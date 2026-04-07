# Sync Visibility Artifact

## Intent
This artifact records the full-sync visibility slice that turns the old coarse popup into a real operator progress surface backed by the live ingestion run state.

## Problem
The previous popup only showed four coarse workflow steps. It did not tell the user:
- how many files were in the run,
- which file was active,
- whether a specific stage had failed,
- or what was happening per document.

That made large syncs feel opaque, especially when the user was running 40+ files.

## Architectural Decision
Drive the popup from the backend `TaskView` rather than UI timers.

Why this matters:
- the control plane already exposes the sync run as a task,
- document records already hold parse/index/error state,
- and the popup should reflect the truth of the workflow, not an estimated animation.

## Backend Changes
Files:
- `backend/src/ghostdash_api/schemas.py`
- `backend/src/ghostdash_api/control_api.py`
- `backend/src/ghostdash_api/workflows.py`

Changes:
- Extended `TaskStepView` with a `status` field: `pending | running | completed | failed`.
- Added `TaskDocumentView` to expose document-level sync state.
- Extended `TaskView` with:
  - `total_documents`
  - `completed_documents`
  - `failed_documents`
  - `active_document_id`
  - `active_filename`
  - `documents`
- Stored `document_ids` in the run payload during workflow preparation.
- Tracked `current_document_id` and `current_filename` in the run result during parse and index phases.
- Preserved progress updates while exposing enough state for the popup to render a truthful file-by-file view.

## Frontend Changes
Files:
- `ui/src/api.ts`
- `ui/src/components/AppLayout.tsx`
- `ui/src/components/FullScreenLoader.tsx`

Changes:
- Extended the frontend `Task` type to match the richer task contract.
- Replaced the old static sync overlay with a live task-driven popup.
- Added:
  - current file of total,
  - real progress bar,
  - active filename,
  - color-coded step rows,
  - scrollable per-document status list,
  - passed/failed summary counts.
- Changed the polling loop to keep the popup open on failures instead of auto-dismissing the error state.

## Human Test Findings
Initial human test on the live deployment exposed two backend regressions introduced while wiring the counters:
- `name 'processed' is not defined`
- `name 'indexed' is not defined`

Both were fixed and the stack was rebuilt between tests.

Final human test on `https://ghoststack.rideai.com.au/` confirmed:
- the previous NameErrors are gone,
- the popup shows `File X of Y`,
- the active filename updates,
- the progress bar moves during a live run,
- step rows show running/completed/failed states,
- per-document statuses render and update during sync,
- and the sync continues beyond the previous failure point.

## Operator Outcome
The user now has immediate visibility into:
- how large the sync batch is,
- where the run is up to,
- which file is active,
- which stage failed,
- and which documents have already passed or failed.

## Residual Risk
- The popup now reflects the live run truthfully, but document recovery actions are still separate work.
- If the workflow model expands to expose chunk-level events later, the popup can be extended again without replacing this task contract.

## Verify Commands
- `cd /var/llamaindex/ghoststack-rag && docker compose up -d --build control-api workflow-runtime agent-ingress ui`
- `cd /var/llamaindex/ghoststack-rag/ui && npm exec vite build -- --outDir dist-check`
- `docker logs --tail=120 ghoststack-rag-control-api-1`
- `docker logs --tail=120 ghoststack-rag-workflow-runtime-1`

## Acceptance Criteria
- Triggering `Full Sync` opens a popup backed by the live task contract.
- The popup shows current file count, current filename, a progress bar, and per-document rows.
- Step rows can render green/red/running states from backend truth.
- The popup no longer fails with the previous NameErrors under a real multi-file sync.
