# Metadata Query Fix Artifact

## Goal

Repair GhostChat’s ability to answer file inventory and exact-filename questions from grounded system metadata instead of claiming it cannot see filenames when the backend already has them.

## Problem found

The failure was not that Qdrant lacked metadata.

The real defect was:

1. `build_query_plan()` returned rich `citations` containing `filename`, `source_path`, `parse_lane`, and page metadata.
2. But the LLM prompt context only included raw chunk text under `Semantic retrieval candidates`.
3. So the model could quote document content, infer titles from the text, and still honestly say it could not confirm the exact stored filename, because the exact file metadata never entered the prompt it was asked to reason over.

This created the bad operator experience where:

- the API response already contained `filename: 426038-PDF-ENG.pdf`
- but the generated answer still said it could not confirm the actual stored filename

## Changes applied

Updated `backend/src/ghostdash_api/workflows.py`:

- added `select_documents_for_corpora()` so the query planner can use the canonical `documents` table directly across one or more corpora
- added document-inventory helpers to build:
  - manifest citations
  - manifest context
  - deterministic inventory answers
- added inventory-query detection for file/filename/metadata/document-list style questions
- changed semantic prompt assembly so each retrieval hit now includes an explicit metadata line before the retrieved text, including:
  - `filename`
  - `corpus`
  - `artifact_type`
  - `source_path`
  - `parse_lane`
  - section/page/sheet/table/row location when available
- added a deterministic manifest-answer path for listing questions such as “what files are in this corpus?”

Updated `backend/tests/test_ingestion_qdrant_batching.py`:

- extended the semantic query-plan test to assert filename/source-path metadata now appears in the prompt
- added a regression test proving inventory-listing questions answer from the document manifest without needing embeddings

## Why this is fit for purpose

- It does not add a duplicate metadata store.
- It uses the existing single source of truth for file inventory: the `documents` table.
- It keeps semantic retrieval for content matching, but stops hiding exact file metadata from the model.
- It improves reliability for both:
  - pure inventory questions
  - content-driven questions that still need the exact stored filename

## Verification performed

Automated/static:

- `python3.12 -m compileall backend/src`
- `ReadLints` on the edited backend source/test files: clean

Live stack verification:

- rebuilt `workflow-runtime`
- verified the live `/agent/chat` path with fresh prompts

Confirmed live:

1. Inventory query:
   - prompt: `List every indexed file currently in active corpus re-finance-080526 with exact filenames.`
   - result: returned the exact indexed filenames from the corpus instead of refusing on metadata grounds

2. Exact filename query:
   - prompt: `Do you have any Generative and Agentic AI documents? If yes, name the exact stored filename and extension.`
   - result: returned `426038-PDF-ENG.pdf`

Human/browser QA:

- browser interaction confirmed GhostChat now returns concrete filename answers instead of the old “I cannot confirm the filename” style response
- note: screenshot/OCR transcription in browser automation can slightly distort alphanumeric filenames, so exact filename fidelity was verified primarily through the live API response body

## Acceptance criteria

- file inventory questions can be answered from canonical document metadata: met
- semantic filename questions can return the exact stored filename: met
- no new duplicate settings or metadata ownership surfaces were introduced: met
- live chat path no longer fails with the old metadata-uncertainty behavior for the tested prompts: met

## Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag
python3.12 -m compileall backend/src
docker compose up -d --build workflow-runtime
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

```bash
cd /var/llamaindex/ghoststack-rag
python3 - <<'PY'
import json, urllib.request
payload = {
    "message": "List every indexed file currently in active corpus re-finance-080526 with exact filenames.",
    "api_mode": "responses",
    "agent_id": "2564d0e0-4cf3-4dab-8e78-91c6e4daf9cc",
}
req = urllib.request.Request(
    "http://localhost/agent/chat",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
)
print(urllib.request.urlopen(req, timeout=120).read().decode())
PY
```

```bash
cd /var/llamaindex/ghoststack-rag
python3 - <<'PY'
import json, urllib.request
payload = {
    "message": "Do you have any Generative and Agentic AI documents? If yes, name the exact stored filename and extension.",
    "api_mode": "responses",
    "agent_id": "2564d0e0-4cf3-4dab-8e78-91c6e4daf9cc",
}
req = urllib.request.Request(
    "http://localhost/agent/chat",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
)
print(urllib.request.urlopen(req, timeout=120).read().decode())
PY
```

## Human retest request

Please retest these in GhostChat:

1. `List every indexed file currently in active corpus re-finance-080526 with exact filenames.`
2. `Do you have any Generative and Agentic AI documents? If yes, name the exact stored filename and extension.`

Expected:

- no “I cannot confirm the filename” style hedge for these prompts
- exact stored filenames returned directly
