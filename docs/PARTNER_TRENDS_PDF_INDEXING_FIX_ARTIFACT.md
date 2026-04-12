# Partner Trends PDF Indexing Fix

## Goal

Repair the live indexing failure exposed by `docs/2026-PARTNER-TRENDS-MASTER.pdf` without touching unrelated UI or collection-management behavior.

## Root Cause

Two backend bugs combined into one operator-visible failure:

1. `backend/src/ghostdash_api/runtime.py` sent large embedding requests through a single `get_text_embedding_batch(...)` call, so TEI could receive more than its configured maximum of `8` inputs in one request.
2. `backend/src/ghostdash_api/workflows.py` only initialized `current_batch_index` after embeddings succeeded and Qdrant upsert batches were built.

That meant the real failure:

- `batch size 100 > maximum allowed batch size 8`

was then masked by a second exception during failure logging:

- `UnboundLocalError: cannot access local variable 'current_batch_index' where it is not associated with a value`

## Fixes Applied

Updated `backend/src/ghostdash_api/settings.py`:

- added `app_embedding_batch_size` with a default of `8`

Updated `backend/src/ghostdash_api/runtime.py`:

- passed the app batch size into `OpenAIEmbedding(...)`
- added explicit app-side chunking so `embed_texts()` never sends more than the configured number of texts per embedding request
- reused the same chunking path for both cache-disabled and cache-miss embedding calls

Updated `backend/src/ghostdash_api/workflows.py`:

- initialized index-batch logging fields before any embedding or Qdrant batching work begins
- preserved the original embedding exception in `ingestion.index.failed` when failure happens before the first upsert batch

Updated `.env.example`:

- documented `APP_EMBEDDING_BATCH_SIZE=8`

Updated regression coverage:

- `backend/tests/test_embedding_cache.py`
- `backend/tests/test_ingestion_qdrant_batching.py`

## Why This Fix Is Fit For Purpose

- It keeps the current LlamaIndex + TEI path intact.
- It does not rely on downstream client batching behavior.
- It does not add a second embedding system or duplicate ingestion state.
- It makes early embedding failures observable instead of masking them behind logging errors.

## Targeted Verification

### Automated tests

```bash
cd /var/llamaindex/ghoststack-rag
docker exec ghoststack-rag-workflow-runtime-1 pytest \
  tests/test_embedding_cache.py \
  tests/test_ingestion_qdrant_batching.py -q
```

### Live rerun for `2026-PARTNER-TRENDS-MASTER.pdf`

Create an isolated collection/corpus for the rerun:

```bash
cd /var/llamaindex/ghoststack-rag
export CORPUS="partner-trends-$(date +%s)"
curl -sS -X POST "http://localhost/api/collections" \
  -H "Content-Type: application/json" \
  -d "{\"slug\":\"${CORPUS}\",\"name\":\"${CORPUS}\"}"
```

Upload the PDF using the default policy lane so the live parse path can still resolve to `default_auto_local_accepted`:

```bash
cd /var/llamaindex/ghoststack-rag
export CORPUS="replace-with-created-corpus"
curl -sS -X POST "http://localhost/api/upload" \
  -F "corpus=${CORPUS}" \
  -F "policy_lane=default" \
  -F "file=@docs/2026-PARTNER-TRENDS-MASTER.pdf;type=application/pdf"
```

Trigger sync and poll until the ingestion task finishes:

```bash
cd /var/llamaindex/ghoststack-rag
export CORPUS="replace-with-created-corpus"
python3 - <<'PY'
import json, os, time, urllib.request

base = "http://localhost"
corpus = os.environ["CORPUS"]
req = urllib.request.Request(
    base + "/api/sync",
    data=json.dumps({"corpus": corpus}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
task = json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
state = None
for _ in range(180):
    time.sleep(2)
    state = json.loads(urllib.request.urlopen(base + "/api/tasks/" + task["id"], timeout=120).read().decode())
    if state["status"] in {"completed", "failed"}:
        break
print("TASK", json.dumps(state, indent=2))
print("DOCS", urllib.request.urlopen(base + "/api/documents?corpus=" + corpus, timeout=120).read().decode())
print("RUNS", urllib.request.urlopen(base + "/api/runs?corpus=" + corpus, timeout=120).read().decode())
PY
```

Verify the document kept the expected local parse lane and completed indexing:

```bash
cd /var/llamaindex/ghoststack-rag
export CORPUS="replace-with-created-corpus"
docker exec ghoststack-rag-postgres-1 psql -U ghostdash -d ghostdash -At -F $'\t' -c \
"select filename, actual_parse_lane, metadata_json->'pdf_parse_diagnostics'->>'decision', parse_status, index_status, coalesce(error_message, '') from documents where corpus = '${CORPUS}' order by updated_at desc limit 1;"
```

## Expected Results

- the sync task finishes with `status = completed`
- the latest document row for the rerun corpus shows:
  - `filename = 2026-PARTNER-TRENDS-MASTER.pdf`
  - `actual_parse_lane = local_pypdf`
  - `metadata_json->pdf_parse_diagnostics->>decision = default_auto_local_accepted`
  - `parse_status = completed`
  - `index_status = completed`
  - empty `error_message`

## Acceptance Criteria

- TEI never receives more than the configured embedding batch size from app-side embedding calls
- embedding failures before the first Qdrant upsert batch no longer throw `UnboundLocalError`
- the original embedding exception remains visible in `ingestion.index.failed`
- the partner-trends PDF can parse and index successfully on the default policy path

## Human Retest Request

Please re-run the live partner-trends PDF flow with the commands above and confirm:

1. the task completes instead of failing during indexing
2. the document row shows `actual_parse_lane=local_pypdf`
3. the document row shows `index_status=completed`
4. no masked `UnboundLocalError` appears during the run
