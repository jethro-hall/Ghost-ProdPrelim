# Phase 2 Document-Aware Retrieval Artifact

## Scope

Phase 2 repairs the long-document retrieval gap in `build_query_plan()` without disturbing the existing document-inventory or structured-row paths.

The purpose of this phase is to keep the architecture honest:

- global semantic retrieval still provides cross-document grounding
- document inventory questions still use the manifest path
- structured row answers still use the workbook path
- when one document is clearly the real target, the system may add a second, document-scoped semantic pass instead of pretending a few global snippets are enough

## Problem Statement

Before this change, semantic retrieval always stopped after a single global top-k Qdrant search.

That was acceptable for short documents and mixed-corpus questions, but it was weak for long-document asks such as `docs/2026-PARTNER-TRENDS-MASTER.pdf`:

- the first pass often found the right document
- the prompt still only contained a few snippets from that document
- the answer model then had to synthesize broad document claims from narrow context

This created a retrieval fidelity gap rather than a parsing or indexing gap.

## Files Changed

- `backend/src/ghostdash_api/qdrant_store.py`
- `backend/src/ghostdash_api/workflows.py`
- `backend/tests/test_qdrant_store.py`
- `backend/tests/test_ingestion_qdrant_batching.py`
- `docs/PHASE2_DOCUMENT_AWARE_RETRIEVAL_ARTIFACT.md`

## Implemented Behavior

### Qdrant filter support

`search_vectors()` now supports an optional `document_ids` constraint while preserving the active corpus filter.

This is implemented as one internal search-filter helper:

- corpus filtering stays in place
- document scoping adds `document_id` matching on top
- multi-value filters use keyword-any matching rather than collapsing corpora or document ids into a single invented field

### Reused semantic formatting

Semantic hit handling in `workflows.py` is now split into reusable helpers for:

- prompt-context formatting
- citation serialization
- dedupe across the global pass and the document-scoped pass

This avoids duplicating prompt/citation logic for the second retrieval step.

### Target-document selection heuristics

Document-scoped expansion only runs for semantic or blended queries and only when a target document is conservative enough to trust.

Current heuristics:

1. `filename mention`

- if the user question explicitly mentions a filename
- and that filename appears in the global semantic hits
- select that document for expansion

Matching is conservative:

- exact case-insensitive filename substring match is accepted
- normalized punctuation-insensitive filename match is accepted
- normalized stem-only matching requires a long stem to avoid short-name false positives

2. `document dominance`

- the top document must contribute at least `3` semantic hits
- it must hold at least `60%` of the global hit count
- it must hold at least `65%` of the aggregate semantic score
- it must lead the next document by at least `2` hits
- or all global semantic hits must come from the same document

This intentionally prefers false negatives over false positives.

### Document-scoped expansion

When a target document is selected:

- the system runs a second Qdrant semantic search against the same corpora and the selected `document_id`
- the second search uses a larger limit than the initial global `top_k`
- current cap logic is `min(max(top_k * 3, 8), 18)`
- duplicate hits are removed before prompt assembly and citation emission
- the extra material is appended as a separate `Document-scoped expansion` section in the prompt

The global semantic hits are preserved. Expansion adds evidence; it does not replace the first pass.

## Preserved Boundaries

This phase intentionally does **not** collapse existing paths together.

- document inventory listing questions still short-circuit to the manifest answer path and do not call embeddings
- structured row answers still retain their existing direct-answer behavior
- UI provenance display is still deferred to Phase 3

## Verification Performed

### Automated tests

Executed from a temporary Python 3.12 virtual environment outside the repo:

```bash
cd /var/llamaindex/ghoststack-rag/backend
/tmp/ghostdash-backend-venv/bin/python -m pytest \
  tests/test_qdrant_store.py \
  tests/test_ingestion_qdrant_batching.py -q
```

Observed result:

- `13 passed in 3.56s`

### Live query-plan verification against the indexed partner-trends PDF

Using the current backend source tree mounted into a one-off container on the live Docker network:

```bash
cd /var/llamaindex/ghoststack-rag
docker run -i --rm \
  --network ghoststack-rag_default \
  -e PYTHONPATH=/app/src \
  -v "/var/llamaindex/ghoststack-rag/backend:/app:ro" \
  -w /app \
  ghoststack-rag-workflow-runtime python - <<'PY'
from collections import Counter
from ghostdash_api.workflows import build_query_plan

message = "In 2026-PARTNER-TRENDS-MASTER.pdf, summarize the major partner trends and cite the source sections."
plan = build_query_plan(
    message=message,
    corpora=["re-finance26"],
    top_k=6,
    trace_id="phase2-live-check",
)

prompt = plan.get("prompt") or ""
print("QUERY_MODE", plan.get("query_mode"))
print("CITATION_COUNT", len(plan.get("citations") or []))
print("HAS_EXPANSION", "Document-scoped expansion:" in prompt)
print("FILENAMES", Counter(citation.get("filename") for citation in plan.get("citations") or []).most_common(5))
if "Document-scoped expansion:" in prompt:
    block = prompt.split("Document-scoped expansion:\n", 1)[1]
    print("EXPANSION_BLOCK_START")
    print(block[:1400])
    print("EXPANSION_BLOCK_END")
PY
```

Observed result from this repo state:

- `QUERY_MODE semantic`
- `CITATION_COUNT 20`
- `HAS_EXPANSION True`
- citation distribution heavily shifted toward `2026-PARTNER-TRENDS-MASTER.pdf`
- expansion block identified `selection_reason=filename mention`

## Real Before/After Flow

Use the same indexed corpus and the same question on both a pre-Phase-2 checkout/image and this Phase 2 checkout.

Question:

- `In 2026-PARTNER-TRENDS-MASTER.pdf, summarize the major partner trends and cite the source sections.`

### Before Phase 2

Run the live query-plan command above against the pre-change checkout or image.

Expected baseline:

- `HAS_EXPANSION False`
- citation count stays at or near the initial global `top_k`
- the prompt only contains the `Semantic retrieval candidates` section

### After Phase 2

Run the same command against this checkout.

Expected result:

- `HAS_EXPANSION True`
- citation count is greater than the initial `top_k`
- the prompt includes a `Document-scoped expansion` section
- the expansion target is `2026-PARTNER-TRENDS-MASTER.pdf`
- most citations come from that target document instead of only a few scattered global hits

## Acceptance Criteria

- semantic retrieval can optionally constrain the second Qdrant pass by `document_id` while preserving corpus filtering
- semantic prompt/citation formatting is reusable across global and document-scoped passes
- explicit filename mention in the question can select a document for expansion when that filename is present in semantic hits
- clear single-document dominance across global semantic hits can select a document for expansion
- document-scoped expansion adds grounded context instead of replacing the original global hits
- document inventory listing questions still do not call embeddings
- structured direct-answer behavior remains intact

## Exact Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag
git status -sb
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker logs --tail=120 ghoststack-rag-control-api-1
docker logs --tail=120 ghoststack-rag-workflow-runtime-1

cd /var/llamaindex/ghoststack-rag/backend
/tmp/ghostdash-backend-venv/bin/python -m pytest \
  tests/test_qdrant_store.py \
  tests/test_ingestion_qdrant_batching.py -q

cd /var/llamaindex/ghoststack-rag
docker exec ghoststack-rag-postgres-1 psql -U ghostdash -d ghostdash -At -F $'\t' -c \
"select corpus, filename, parse_status, index_status from documents where filename = '2026-PARTNER-TRENDS-MASTER.pdf' order by updated_at desc;"

docker run -i --rm \
  --network ghoststack-rag_default \
  -e PYTHONPATH=/app/src \
  -v "/var/llamaindex/ghoststack-rag/backend:/app:ro" \
  -w /app \
  ghoststack-rag-workflow-runtime python - <<'PY'
from collections import Counter
from ghostdash_api.workflows import build_query_plan

message = "In 2026-PARTNER-TRENDS-MASTER.pdf, summarize the major partner trends and cite the source sections."
plan = build_query_plan(
    message=message,
    corpora=["re-finance26"],
    top_k=6,
    trace_id="phase2-verify",
)

prompt = plan.get("prompt") or ""
print("QUERY_MODE", plan.get("query_mode"))
print("CITATION_COUNT", len(plan.get("citations") or []))
print("HAS_EXPANSION", "Document-scoped expansion:" in prompt)
print("FILENAMES", Counter(citation.get("filename") for citation in plan.get("citations") or []).most_common(5))
PY
```

## Human Retest Request

Please retest the partner-trends question from an operator perspective after this backend slice is in your chosen runtime:

1. Ask for a summary that explicitly names `2026-PARTNER-TRENDS-MASTER.pdf`.
2. Confirm the answer carries broader coverage than a few isolated snippets.
3. Confirm the citations are mostly from the partner-trends PDF rather than unrelated files.
4. If you still see thin answers, capture the query, citation count, and whether the prompt/query-plan showed `Document-scoped expansion` so the next repair can target chunk quality rather than retrieval routing.

## Residual Risk

- the expansion is still vector-only within a single document, so noisy OCR-style chunks can still be selected if the underlying indexed text is poor
- only one target document is expanded; genuinely multi-document synthesis questions still rely mostly on the global pass
- running containers do not automatically load this repo state, so live stack behavior still requires either rebuild/redeploy or the mounted-source verification method above
