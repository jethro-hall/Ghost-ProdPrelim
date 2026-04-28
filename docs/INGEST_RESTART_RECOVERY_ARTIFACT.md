# Ingest Restart Recovery Artifact

## Scope
This artifact records the ingestion-runtime recovery work applied after the payload batching fix, specifically to prevent orphaned `pending` or `running` sync rows after a `workflow-runtime` restart.

## Diagnosis
- `workflow-runtime` previously tracked active ingestion jobs only in the in-memory `ACTIVE_INGEST_TASKS` map.
- If the container restarted during a sync, the database still showed the run as `pending` or `running`, but no live worker remained attached to it.
- `control-api` reused those rows from `POST /api/sync`, but did not retrigger them, so the UI could appear stuck on a stale active run.
- Restart testing also showed that running ingestion work directly in the API server event loop could interfere with container health checks during recovery windows.

## Changes Applied
- Updated `backend/src/ghostdash_api/workflow_runtime.py` to:
  - identify persisted `pending` and `running` full-sync runs on startup
  - keep only the newest recoverable run per corpus
  - mark older duplicates as failed with a superseded message
  - schedule startup recovery after a short delay so the service can become healthy first
  - execute ingestion jobs in a child Python process so the HTTP server remains responsive while workflows run
- Updated `backend/src/ghostdash_api/control_api.py` so reused sync requests retrigger the existing run in `workflow-runtime` instead of only returning the stale task row.
- Added focused regression coverage in `backend/tests/test_workflow_runtime_recovery.py` for recoverable-run selection.

## Verification Performed
- Verified backend syntax with:
  - `python3 -m compileall backend/src/ghostdash_api`
- Rebuilt the affected services with:
  - `docker compose up -d --build workflow-runtime`
  - `docker compose up -d control-api`
- Confirmed runtime health endpoint responsiveness from inside the container.
- Triggered a fresh small-corpus sync on `xlsx-native-1775456954` and confirmed it completed successfully.
- Confirmed a recovered `default` run resumed automatically after runtime restart and continued progressing.
- Triggered `POST /api/sync` again while the recovered `default` run was active and confirmed:
  - `control-api` returned the same run id
  - `control-api` logged `sync.reused`
  - `workflow-runtime` logged `ingest.job.duplicate`
- Performed browser-based human verification on the Operational Trace page and confirmed:
  - the small-corpus run showed completed
  - the recovered `default` sync showed active progress
  - the UI did not appear stuck on a stale orphaned run

## Live Evidence Summary
- Small-corpus verification run:
  - run id: `adbc1baa-c128-43bf-bdd9-19233bf37f4a`
  - corpus: `xlsx-native-1775456954`
  - status: `completed`
  - result:
    - `documents_total: 1`
    - `documents_processed: 1`
    - `documents_failed: 0`
    - `documents_index_failed: 0`
    - `documents_indexed: 1`
- Recovered `default` run:
  - run id: `16dcc6bd-23c8-4a85-9f71-f7f674089cb6`
  - status after recovery: `running`
  - evidence:
    - `workflow-runtime` logged `ingest.job.recovery.scheduled`
    - `workflow-runtime` logged `ingest.job.recovered`
    - `workflow-runtime` resumed parse progress on live documents
- Reuse verification:
  - `control-api` logged `sync.reused` with `runtime_retriggered: true`
  - `workflow-runtime` logged `ingest.job.duplicate` for the active recovered run instead of starting a second copy

## Residual Risk
- Restart recovery is now functional for ingestion runs, but the container naming behavior during repeated compose rebuilds was noisy during testing and should be monitored in future environment cleanup work.
- Startup recovery intentionally resumes the newest recoverable run per corpus and marks older duplicates as superseded. If your desired policy is to recover every distinct run rather than deduplicate by corpus, that would need a different queue strategy.

## Exact Verify Commands
```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker logs --tail=120 ghoststack-rag-workflow-runtime-1
docker logs --tail=120 ghoststack-rag-control-api-1
curl -sS 'http://localhost/api/runs?corpus=default'
curl -sS 'http://localhost/api/runs?corpus=xlsx-native-1775456954'
curl -sS 'http://localhost/api/tasks/16dcc6bd-23c8-4a85-9f71-f7f674089cb6'
curl -sS 'http://localhost/api/tasks/adbc1baa-c128-43bf-bdd9-19233bf37f4a'
```

## Human Retest Request
Please open the Logs / Operational Trace page and confirm that:
- The latest `xlsx-native-1775456954` run shows completed with `1 processed` and `0 failed`.
- The current `default` run shows live progress instead of a stale orphaned state.
- Clicking sync again while that `default` run is active does not create a duplicate active run card.
