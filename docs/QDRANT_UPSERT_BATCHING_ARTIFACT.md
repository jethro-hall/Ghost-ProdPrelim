# Qdrant Upsert Batching Artifact

## Problem

Large document indexing runs were failing in `index_retrieval` with Qdrant payload errors:

- `Payload error: JSON payload (...) is larger than allowed (limit: 33554432 bytes)`

Root cause: the code sent one large `qc.upsert()` payload per document, which exceeded Qdrant's 32MB request limit for large XLSX/PDF workloads.

## Architectural Change

Updated the retrieval upsert choke point to enforce bounded batch writes:

- File: `backend/src/ghostdash_api/qdrant_store.py`
- Function: `upsert_retrieval_artifacts(...)`

New behavior:

- Estimates point payload size (`payload + vector`) for each point.
- Splits writes into multiple `qc.upsert()` calls using:
  - `app_qdrant_upsert_max_payload_bytes` (default `24MB`)
  - `app_qdrant_upsert_max_points` (default `128`)
- Preserves existing output contract (`list[str]` point IDs in input order).

Configuration added in `backend/src/ghostdash_api/settings.py`:

- `app_qdrant_upsert_max_payload_bytes: int = 24 * 1024 * 1024`
- `app_qdrant_upsert_max_points: int = 128`

## Why This Fix

- Keeps ingestion native-first with current stack (no new infra).
- Resolves hard failure mode without changing parse/index semantics.
- Adds safe tuning knobs for future load profiles.

## Verification Performed

1. Rebuilt and redeployed:
   - `docker compose up -d --build workflow-runtime control-api`
2. Triggered real full sync on corpus `default`.
3. Observed workflow logs showing successful Qdrant upserts for previously failing large files (including `journal_report.xlsx`) with no payload-size rejection events.
4. Confirmed `documents_failed: 0` while indexing progressed past earlier failure points.

## Residual Risk

If workflow/control services restart mid-run, existing `running` runs can remain stuck as `running` (dedupe then reuses that stale run). This is adjacent reliability work and should be addressed with stale-run recovery/timeout logic.

## Recommended Next Hardening

1. Add stale run lease/heartbeat and auto-fail recovery.
2. Emit per-batch upsert telemetry (`batch_points`, `estimated_bytes`) for observability.
3. Add regression test for oversized-document upsert batching behavior.
