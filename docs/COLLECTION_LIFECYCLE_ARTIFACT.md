# Collection Lifecycle Artifact

## Scope

This artifact documents the managed RAG collection lifecycle added to GhostDASH for:

- explicit collection creation
- validated collection attachment to agent runtime profiles
- destructive collection deletion with full storage sweep

## Architecture Decision

GhostDASH now treats a collection as a **canonical Postgres entity** rather than a free-text `corpus` string alone.

The storage model is:

- `collections` is the source of truth for managed collection identity
- `runtime_profile_collections` owns runtime-profile to collection bindings
- document rows still carry `corpus` as the operational retrieval namespace
- Qdrant remains a **single shared physical collection** with `corpus` payload filtering

This keeps the current Postgres + Qdrant architecture fit-for-purpose while removing the unsafe behavior where typos or stale JSON could create orphaned logical collections.

## Why This Is Fit For Purpose

- It matches the repo's current architecture instead of forcing a premature migration to one physical Qdrant collection per business collection.
- It creates one canonical lifecycle owner in Postgres for create, attach, and delete operations.
- It preserves the existing retrieval approach and ingestion workflow with minimal runtime disruption.
- It gives the UI a validated picker model instead of free-text collection entry.

## Storage Points Covered By Delete

Deletion now removes the collection from all currently known primary storage points in this stack:

1. Postgres `collections`
2. Postgres `runtime_profile_collections`
3. Postgres `documents`
4. Postgres `document_versions`
5. Postgres `retrieval_artifacts`
6. Postgres workbook structure tables:
   `workbook_artifacts`, `workbook_sheets`, `workbook_tables`, `workbook_rows`
7. Postgres `ingestion_runs`
8. Postgres conversation/cache state referencing the collection:
   `agent_conversations`, `agent_messages`, `chat_response_cache`
9. Qdrant vector points filtered by collection slug
10. Uploaded files under `/data/uploads/<collection-slug>`

## Delete Invariants

After a successful delete:

- there is no `collections` row for the slug
- there are no document or artifact rows for the slug
- there are no runtime-profile attachment rows for the slug
- no runtime profile still lists the slug in `kb_config.default_corpora`
- Qdrant returns `0` points for the slug
- the upload directory for the slug does not exist

## API Surfaces Added

- `GET /api/collections`
- `POST /api/collections`
- `GET /api/collections/{collection_id}`
- `DELETE /api/collections/{collection_id}`

## UI Surfaces Updated

- `Data Sources`
  - explicit collection create
  - impact-aware collection delete
  - uploads target a selected managed collection
- `Agent Config`
  - agent runtime profile attaches to managed collections via validated checkboxes
- `Pipelines`
  - default runtime collections use managed collection selection instead of free-text corpora

## Verification Performed

### Code-Level Verification

- `python3.12 -m compileall backend/src`
- focused backend tests:
  - `backend/tests/test_runtime_profiles.py`
  - `backend/tests/test_collections.py`
- frontend build in container:
  - `pnpm run build`
- `docker compose config`

### Live Stack Verification

A real lifecycle test was executed against the rebuilt Docker stack:

1. Created a managed collection
2. Attached it to a live agent runtime profile
3. Uploaded a text file to that collection
4. Ran ingestion sync to completion
5. Observed pre-delete impact including document, version, vector, and attachment counts
6. Deleted the collection through the live API
7. Verified post-delete runtime state from inside the running container

Observed post-delete state for the test collection:

- `collection_rows: 0`
- `document_rows: 0`
- `document_version_rows: 0`
- `retrieval_artifact_rows: 0`
- `ingestion_run_rows: 0`
- `runtime_profile_links: 0`
- `runtime_profile_defaults_containing_slug: []`
- `vector_points: 0`
- `upload_dir_exists: False`

### Cleanup Verification

After the follow-up cleanup pass, all stale non-default test/debug collections were removed from the live stack.

Observed live post-cleanup state:

- managed collections remaining: `default` only
- default collection document count: `62`
- default collection vector count: `97,517`
- both live agents resolve only `default`
- system total, runtime default access, and primary collection totals now reconcile to the same live namespace after cleanup

The UI was also updated so these scopes are presented explicitly rather than implied:

- `System Total`
- `Runtime Default Access`
- `Primary Collection`

## Known Limitation

Local browser automation in this environment could not connect to the host-served app even though shell HTTP access to `http://127.0.0.1/` succeeded, so the final UI flow was validated by:

- successful frontend build
- live API/runtime verification
- a requested human retest step below

## Human Retest Request

Please perform this human check in the live app:

1. Open `Data Sources`
2. Create a new collection
3. Confirm it appears in Managed Collections
4. Open `Agent Config`
5. Attach that collection to an agent and save
6. Re-open the same agent and confirm the attachment persisted
7. Return to `Data Sources`
8. Delete the collection
9. Confirm it disappears from the picker/cards
10. Confirm the same collection is no longer attached when reopening the agent

## Acceptance Criteria

- Collections can be created explicitly.
- Uploads target a selected managed collection.
- Agents can be attached to one or more managed collections.
- Collection deletion removes DB rows, vectors, files, and runtime-profile bindings.
- Deletion blocks while active ingestion runs exist.
- The repo contains an artifact documenting the lifecycle and verification evidence.

## Exact Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag
python3.12 -m compileall backend/src
APP_DB_URL=sqlite:////tmp/ghostdash-test.db PYTHONPATH=backend/src python3.12 -m pytest backend/tests/test_runtime_profiles.py backend/tests/test_collections.py -q
docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run build"
docker compose config
python3 - <<'PY'
import json, urllib.request
for path in ("/api/collections", "/api/agents"):
    with urllib.request.urlopen("http://127.0.0.1" + path, timeout=10) as response:
        print(path, response.status)
        print(response.read(400).decode())
PY
docker exec ghoststack-rag-control-api-1 sh -lc "python - <<'PY'
from sqlalchemy import select, func
from ghostdash_api.database import SessionLocal
from ghostdash_api.models import CollectionRecord
with SessionLocal() as session:
    print('collections', session.scalar(select(func.count(CollectionRecord.id))) or 0)
PY"
```
