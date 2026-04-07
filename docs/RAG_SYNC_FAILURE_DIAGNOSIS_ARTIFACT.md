## RAG Sync Failure Diagnosis Artifact

### Scope

Investigated two user-visible failures in the GhostDASH RAG stack:

- historical full-sync runtime failures such as `name 'indexed' is not defined` and `name 'processed' is not defined`
- upload-time `AxiosError: Request failed with status code 502` for spreadsheet files

### Root Causes

1. Proxy-side 502s were not caused by Caddy itself.
   - `caddy` was returning 502 because `control-api` disappeared from Docker DNS while the stack was unstable.
   - The immediate upstream errors observed were:
     - `dial tcp: lookup control-api on 127.0.0.11:53: no such host`
     - `dial tcp 172.26.0.6:8000: connect: connection refused`

2. `control-api` startup was coupled too tightly to `workflow-runtime` health.
   - `workflow-runtime` was marked unhealthy during long ingestion work, which blocked `control-api` startup when Compose recreated services.
   - Once `control-api` was absent from the network, `/api/upload`, `/api/documents`, and related UI calls surfaced as 502s.

3. The rebuilt runtime then exposed a worker-launch bug.
   - ingestion was being launched in a context where `IngestionWorkflow.run(...)` executed before a running event loop existed
   - symptom observed in fresh runs: `no running event loop`

4. Exact spreadsheet indexing failures were caused by oversized workbook retrieval artifacts.
   - the workbook row summaries for large export files could exceed the embedding model input limit
   - direct observed error:
     - `Invalid 'input[6]': maximum input length is 8192 tokens.`

### Implemented Fixes

#### 1. Compose resilience

Updated [`docker-compose.yml`](../docker-compose.yml):

- increased `workflow-runtime` healthcheck tolerance
  - `interval: 30s`
  - `timeout: 30s`
  - `start_period: 60s`
  - `retries: 10`
- changed `control-api` and `agent-ingress` to depend on `workflow-runtime` with `condition: service_started` instead of `service_healthy`

Effect:

- `control-api` remains startable and reachable during long-running ingestion
- Caddy no longer loses the `control-api` upstream just because runtime health probes flap

#### 2. Sync trigger hardening

Updated [`backend/src/ghostdash_api/control_api.py`](../backend/src/ghostdash_api/control_api.py):

- increased internal ingest trigger timeout
- added retry behavior for transient runtime connection failures
- preserved user-facing spreadsheet filenames such as `cash_flow_statement (1).xlsx` instead of flattening them to underscore-only names

Effect:

- `/api/sync` is more tolerant during runtime warm-up/recovery
- the exact filenames reported by the user can now be stored and surfaced as-is

#### 3. Runtime entrypoint fix

Updated [`backend/src/ghostdash_api/workflow_runtime.py`](../backend/src/ghostdash_api/workflow_runtime.py):

- changed the worker entrypoint to create the event loop first and only then call `await workflow.run(...)`

Effect:

- fresh syncs now advance beyond `queued`
- observed post-fix behavior:
  - `/internal/ingest` accepted successfully
  - fresh runs progressed into `parse_structure`

#### 4. Workbook artifact bounding

Updated [`backend/src/ghostdash_api/workflows.py`](../backend/src/ghostdash_api/workflows.py):

- bounded `sheet_summary` text using existing chunk settings
- bounded `row_summary` text using existing chunk settings before retrieval artifacts are persisted

Effect:

- oversized workbook rows no longer generate arbitrarily long embedding inputs
- post-fix database evidence for the fresh verification corpus showed:
  - `Export_2025-11-09_205446.xlsx` max artifact text length: `919`
  - `Export_2025-12-22_170026.xlsx` max artifact text length: `919`
  - `Export_2025-12-23_034928.xlsx` max artifact text length: `919`

These are comfortably below the embedding failure scenario that previously exceeded the model limit.

### Human-Style Verification

Browser verification was performed against the live UI:

- main app loaded successfully
- Data Sources page loaded successfully
- Operational Trace page loaded successfully
- document/task data loaded without 502s
- `/api/runs` returned `200 OK`
- no user-visible 502 issue was reproduced after the fixes

### API Verification

Exact six-file upload test through `/api/upload` succeeded with `200` for:

- `cash_flow_statement (1).xlsx`
- `cash_flow_statement.xlsx`
- `Export_2026-03-25_155400.xlsx`
- `Export_2025-12-22_170026.xlsx`
- `Export_2025-11-09_205446.xlsx`
- `Export_2025-12-23_034928.xlsx`

Fresh verification corpus confirmed these filenames exist in `GET /api/documents`.

### Current Runtime State

At the time of this artifact:

- `control-api`, `agent-ingress`, and `workflow-runtime` are healthy/reachable
- the default corpus fresh run is actively progressing in indexing
- the focused verification corpus run has fresh bounded artifacts and is progressing through parse/index without reproducing the earlier `no running event loop` issue

### Residual Risk

`workflow-runtime` still performs startup recovery for any `pending` or `running` full-sync rows found in the database. During repeated runtime rebuilds this can requeue older runs and create noisy overlap while verifying. The behavior is functionally safe, but operationally noisy.

If this becomes a recurring operational problem, the next architectural step should be to move ingestion orchestration to a durable queue/broker rather than in-process task tracking plus startup recovery.

### Exact Verify Commands

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker logs --tail=200 ghoststack-rag-caddy-1
docker logs --tail=200 ghoststack-rag-control-api-1
docker logs --tail=200 ghoststack-rag-workflow-runtime-1
curl -sS http://localhost/api/runs
curl -sS 'http://localhost/api/documents?corpus=verify-502-fixed'
curl -sS 'http://localhost/api/tasks/790e0110-98d1-4f12-87f4-c07c5bcac283'
docker exec ghoststack-rag-postgres-1 psql -U ghostdash -d ghostdash -c "select d.filename, max(length(r.text)) as max_chars, count(*) as artifact_count from retrieval_artifacts r join documents d on d.id = r.document_id where d.corpus = 'verify-502-fixed' group by d.filename order by d.filename;"
```
