# Ingestion Hardening Artifact

## Scope
This artifact records the upload/import/reporting/logging/queueing hardening applied to the live GhostDASH stack after the UI parity work.

## Changes Applied
- Streamed uploads to disk in `backend/src/ghostdash_api/control_api.py` instead of buffering the full file in memory before write.
- Added structured point-in-time telemetry in `backend/src/ghostdash_api/telemetry.py` for upload acceptance, sync enqueue/reuse, trigger acceptance, workflow start/completion, and per-document parse/index milestones.
- Changed `backend/src/ghostdash_api/workflow_runtime.py` so `/internal/ingest` accepts work quickly and runs ingestion in a background task rather than holding the trigger request open for the full workflow duration.
- Prevented duplicate concurrent sync runs for the same corpus in `backend/src/ghostdash_api/control_api.py` by reusing an existing `pending` or `running` ingestion run.
- Added recent ingestion run reporting through `GET /api/runs` using `RunSummaryView` in `backend/src/ghostdash_api/schemas.py`.
- Surfaced recent ingestion runs in the served UI through `ui/src/api.ts` and `ui/src/pages/Logs.tsx`.
- Added richer workflow-stage logging in `backend/src/ghostdash_api/workflows.py` for prepare, parse completion/failure, index completion/failure, and run completion.

## Acceptance Criteria
- Mixed file uploads complete successfully without full-file buffering in the API process.
- Repeated sync requests for the same corpus do not create duplicate concurrent runs.
- Operators can inspect recent ingestion runs through both API and UI.
- Structured logs correlate upload, queue, workflow, and downstream retrieval behavior.
- The rebuilt live stack remains healthy after deployment.

## Verification Performed
- Rebuilt and restarted `control-api`, `workflow-runtime`, and `ui` with `docker compose up -d --build control-api workflow-runtime ui`.
- Confirmed containers healthy with `docker ps`.
- Ran backend syntax verification with `python3 -m compileall backend/src/ghostdash_api`.
- Ran frontend verification with `npm exec tsc -- --noEmit` and `npm exec vite build -- --outDir dist-check-queue`.
- Executed a live API E2E flow against the served stack:
  - uploaded `notes.txt`
  - uploaded `orders.xlsx`
  - called `/api/sync` twice for the same corpus
  - confirmed both sync calls returned the same task id
  - confirmed `/api/runs?corpus=<corpus>` reported one completed run with `documents_processed: 2`
  - confirmed `/api/documents?corpus=<corpus>` showed `notes.txt` as `local_text` and `orders.xlsx` as `local_xlsx` with workbook counts
- Performed browser-based human verification at `https://ghoststack.rideai.com.au/logs` and confirmed the recent ingestion run rendered in the Operational Trace page.

## Live Evidence Summary
- Mixed corpus used: `e2e-queue-1775464309`
- Upload results:
  - `notes.txt` uploaded and indexed
  - `orders.xlsx` uploaded and indexed with `workbook_sheet_count=1`, `workbook_table_count=1`, `workbook_row_count=2`
- Queue behavior:
  - first sync returned run `fc28fe08-cd20-410d-acf8-7c8591c9e56b`
  - second sync for the same corpus reused the same run id instead of creating a duplicate run
- Logging behavior:
  - control-api emitted `upload.accepted`, `sync.queued`, `sync.reused`, and `sync.trigger.accepted`
  - workflow-runtime emitted `ingest.job.accepted`, `ingest.job.started`, `ingestion.prepare`, per-document parse/index events, and `ingestion.run.completed`

## Residual Risk
- The workflow queue is now non-blocking and deduplicated, but it is still in-memory inside `workflow-runtime`; it is not yet a broker-backed durable queue.
- If full crash resilience and replay semantics are required, the next step should be a durable job model backed by the database or a dedicated queue system rather than more in-process task logic.

## Exact Verify Commands
```bash
docker ps --format 'table {{.Names}}	{{.Status}}	{{.Ports}}'
docker logs --tail=120 ghoststack-rag-control-api-1
docker logs --tail=120 ghoststack-rag-workflow-runtime-1
curl -s http://127.0.0.1/api/runs | jq
curl -s http://127.0.0.1/api/documents | jq
```

## Human Retest Request
Please open `https://ghoststack.rideai.com.au/logs` and confirm that:
- Recent ingestion runs render without sticking on loading.
- A repeated `Full Sync` on the same corpus does not create duplicate parallel runs.
- The dashboard still uploads files cleanly and the ingestion history reflects the resulting status changes.
