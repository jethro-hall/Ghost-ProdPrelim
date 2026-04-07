# Index Payload Batching Artifact

## Scope
This artifact records the diagnosis, implementation, and live verification of the oversized Qdrant payload failures seen during `default` corpus full sync runs.

## Diagnosis
- Historical failed runs for `default` showed `8 document(s) failed during indexing`.
- Document-level API evidence showed the failed PDFs were rejected by Qdrant with `Payload error: JSON payload ... is larger than allowed (limit: 33554432 bytes)`.
- The indexing workflow was sending full per-document retrieval payloads in a single upsert request.
- For PDF sentence-window artifacts, the Qdrant payload metadata also duplicated large text fields (`original_text` and `window_text`), which unnecessarily inflated request size.

## Changes Applied
- Added Qdrant payload sanitization in `backend/src/ghostdash_api/workflows.py` so vector-store metadata excludes oversized text-only fields that are not needed for retrieval citations.
- Added estimated request sizing and bounded batch construction for retrieval upserts in `backend/src/ghostdash_api/workflows.py`.
- Added per-batch structured telemetry with:
  - `batch_index`
  - `batch_count`
  - `batch_points`
  - `estimated_request_bytes`
- Added per-document completion telemetry with `upsert_batches` and `estimated_upsert_bytes`.
- Split failure accounting into:
  - `documents_parse_failed`
  - `documents_index_failed`
  - `documents_failed`
- Improved final run error messaging so parse failures and index failures are reported consistently from the same counters.
- Added focused regression coverage in `backend/tests/test_ingestion_qdrant_batching.py` for:
  - payload sanitization
  - oversized batch splitting
  - run failure message formatting

## Verification Performed
- Checked the repository state before edits with `git status -sb`.
- Verified backend syntax with `python3 -m compileall backend/src/ghostdash_api`.
- Rebuilt and restarted backend services with:
  - `docker compose up -d --build control-api workflow-runtime`
- Verified container health with `docker ps`.
- Queried live control API state with:
  - `curl -sS 'http://localhost/api/runs?corpus=default'`
  - `curl -sS 'http://localhost/api/documents?corpus=default'`
- Confirmed runtime telemetry for the successful run included multiple `ingestion.index.upsert.batch` events with bounded request sizes.
- Performed browser-based human verification of the Logs/Operational Trace UI and confirmed the latest successful `default` full sync displayed as completed with `43 processed` and `0 failed`.

## Live Evidence Summary
- Successful validation run:
  - run id: `31bd4486-d45b-41a7-9881-25a4c65cb0c9`
  - corpus: `default`
  - status: `completed`
  - result:
    - `documents_total: 43`
    - `documents_processed: 43`
    - `documents_failed: 0`
    - `documents_parse_failed: 0`
    - `documents_index_failed: 0`
    - `documents_indexed: 43`
- Runtime log evidence confirmed bounded upserts, including examples such as:
  - `agentic-ai-advantage-report.pdf.coredownload.inline.pdf` indexed across `7` batches with an estimated total of `19679826` bytes
  - `RETAIL_profit_and_loss_-_2026-03-20.xlsx` indexed across `2` batches with an estimated total of `3814871` bytes
- Formerly failing PDFs no longer showed `index_status=failed` during successful validation, and the UI no longer showed the payload-size error on the latest successful run.

## Operational Finding
- A separate runtime issue surfaced during verification: if `workflow-runtime` is restarted while a run is active, the database may still show that run as `running` even though the in-memory task has been lost.
- During testing, an orphaned run had to be resumed manually through the runtime endpoint, and a later replacement run completed successfully.
- This issue is distinct from the oversized-payload fix, but it can interfere with operator verification and queue semantics.

## Residual Risk
- Oversized vector upserts are now bounded and the redundant PDF metadata text has been removed from Qdrant payloads, but restart recovery is still not durable.
- `workflow-runtime` still uses in-memory task tracking. A restart during ingestion can leave stale `running` rows or force superseded runs until a fresh run is created.
- If restart-safe queue recovery is required, the next fit-for-purpose improvement is to reconcile persisted `pending/running` runs on startup instead of relying only on in-memory task state.

## Exact Verify Commands
```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker logs --tail=200 ghoststack-rag-workflow-runtime-1
docker logs --tail=200 ghoststack-rag-control-api-1
curl -sS 'http://localhost/api/runs?corpus=default'
curl -sS 'http://localhost/api/documents?corpus=default'
```

## Human Retest Request
Please open the Logs / Operational Trace page and confirm that:
- The latest `default` full sync appears as completed.
- The latest successful run shows `43 processed` and `0 failed`.
- The latest run does not display a payload-size indexing error.
- Starting a sync immediately after a backend restart does not leave the UI stuck on an orphaned `running` entry.
