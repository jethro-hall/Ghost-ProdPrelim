# PDF RAG Implementation Artifact

## Scope

This artifact records the implementation of the GhostDASH native PDF ingestion upgrade that moves the stack from naive character chunking toward a more reliable, provenance-rich, LlamaIndex-native PDF retrieval path.

## Purpose Of This Build

The purpose of GhostDASH is not generic document chat. It is an operator-grade RAG control plane that must stay:

- simple enough to run and debug reliably
- trustworthy enough to answer with clear provenance
- tuneable enough to support premium retrieval quality without constant code edits
- responsive enough for interactive agents and operator workflows

For PDFs specifically, the old path was too coarse:

- local parsing used `pypdf`
- extracted text was sliced with a homegrown character chunker
- metadata was too thin for auditability and future GraphRAG work

That combination worked, but it was not premium. It risked semantic breaks, weaker provenance, and harder downstream tuning.

## What Changed

- Added shared runtime defaults in `backend/src/ghostdash_api/runtime_defaults.py` so PDF tuning is centrally managed.
- Added `cryptography` to `backend/pyproject.toml` so AES-encrypted PDFs are supported by the backend image.
- Added PDF tuning defaults in `backend/src/ghostdash_api/settings.py`:
  - `app_pdf_chunk_size`
  - `app_pdf_chunk_overlap`
  - `app_pdf_sentence_window`
  - `app_pdf_top_k`
  - `app_pdf_parse_lane_policy`
- Expanded runtime defaults API models in `backend/src/ghostdash_api/schemas.py` so tuning is exposed through the existing control plane.
- Updated `backend/src/ghostdash_api/agent_ingress.py` to resolve query `top_k` through runtime defaults when a request does not explicitly provide it.
- Reworked `backend/src/ghostdash_api/ingest.py` to:
  - normalize PDF text
  - suppress repeated header/footer artifacts conservatively
  - attempt passwordless decrypt for encrypted PDFs before extraction
  - build LlamaIndex `Document` objects for PDF pages or LlamaParse markdown
  - run a native `IngestionPipeline` using `SentenceWindowNodeParser`
  - detect weak local extraction and fall back to cloud parsing when policy allows
- Reworked `backend/src/ghostdash_api/workflows.py` to:
  - build one canonical metadata contract for retrieval artifacts
  - persist PDF sentence-window artifacts with richer provenance
  - keep vector embeddings based on precise node text while storing bounded window context for prompt assembly
  - stage GraphRAG readiness via `entity_hints` and `relation_hints`
- Updated `backend/src/ghostdash_api/qdrant_store.py` to create payload indexes for key audit and filter fields and return richer payload metadata on search hits.

## Architecture Decisions

### 1. Keep the current service boundaries

The implementation does not create a second ingestion service or bypass current boundaries:

- `control-api` still owns uploads and run orchestration
- `workflow-runtime` still owns ingestion and retrieval artifact generation
- `postgres` remains the system of record
- `qdrant` remains the vector store

This preserves the operational shape of the existing system.

### 2. Use native LlamaIndex where it helps most

The biggest PDF quality improvement comes from replacing custom string slicing with native node generation:

- `IngestionPipeline`
- `SentenceWindowNodeParser`
- LlamaIndex `Document`

This keeps the stack native where it matters without replacing the existing observability wrappers, DB writes, or Qdrant integration.

### 3. Preserve simple storage

No graph database was added.

Instead, stage-one GraphRAG readiness is recorded directly in artifact metadata with:

- `entity_hints`
- `relation_hints`

This keeps the build simple and reliable while preserving a future path to graph extraction.

### 4. Separate embed text from retrieval context

For PDF sentence-window nodes:

- vector embeddings are generated from the original sentence-level node text
- retrieved prompt context uses bounded `window_text`

That preserves embedding precision while improving answer coherence.

## Canonical Metadata Contract

Every retrieval artifact now carries a shared metadata baseline through `build_retrieval_metadata()`:

- `file_path`
- `ingestion_date`
- `corpus`
- `entity_type`
- `entity_hints`
- `relation_hints`
- `source_id`
- `content_hash`
- `document_version_id`
- `filename`
- `artifact_type`
- `parse_lane`
- `source_path`
- `source_kind`

PDF artifacts additionally carry:

- `chunk_index`
- `page_start`
- `page_end`
- `section_title`
- `token_count`
- `window_text`
- `original_text`
- `node_id`
- `configured_chunk_size`
- `configured_chunk_overlap`
- `configured_sentence_window`

## Why This Is Fit For Purpose

- It upgrades PDF retrieval quality without inventing new infrastructure.
- It keeps the ingestion path deterministic and inspectable.
- It increases provenance fidelity across SQL artifacts and Qdrant payloads.
- It gives operators controlled tuning without asking them to change code for every retrieval adjustment.
- It stages GraphRAG safely instead of pretending the graph layer already exists.

## Acceptance Criteria

- PDFs are no longer indexed only through naive raw character slicing.
- PDF ingestion uses native LlamaIndex document/node generation.
- Retrieval artifacts share one canonical metadata contract.
- Qdrant payloads carry enough provenance for filtering and citation quality.
- Existing async ingestion and duplicate-run protections remain intact.
- GraphRAG is staged through metadata contracts, not premature infrastructure.

## Verification Performed

- Read and mapped the current ingestion/runtime code before changing behavior.
- Verified the live stack names and health using Docker on this host.
- Verified the running `control-api` and `workflow-runtime` logs were healthy before implementation.
- Verified the changed files with editor diagnostics after editing.
- Rebuilt the backend services and verified live PDF ingestion for:
  - a standard sample PDF corpus
  - a passwordless encrypted sample PDF corpus
- Performed browser-based retest and confirmed recent successful PDF runs are visible in the UI after refresh.

## Exact Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag
rg -n "runtime_defaults|pdf_chunk_size|SentenceWindowNodeParser|window_text|entity_hints|relation_hints" backend/src/ghostdash_api docs/PDF_RAG_IMPLEMENTATION_ARTIFACT.md
python3.12 -m compileall backend/src
docker compose config
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker logs --tail=120 ghoststack-rag-control-api-1
docker logs --tail=120 ghoststack-rag-workflow-runtime-1
```

## Human Retest Request

After deploy or local rebuild, please test as an operator:

1. Upload one text-native PDF and one difficult PDF through the UI.
2. Trigger ingestion twice quickly for the same corpus.
3. Ask one exact factual question and one summarization question in the chat UI.
4. Confirm:
   - the exact question cites the correct document and page span when available
   - the summarization answer is coherent and grounded
   - the logs page shows parse and index completion without hidden failures
   - duplicate sync still reuses the active run rather than spawning a second one

## Residual Risk

- `SentenceWindowNodeParser` gives better semantics, but the current runtime still uses custom retrieval orchestration rather than a full LlamaIndex retriever stack.
- GraphRAG is metadata-staged only; entity extraction and graph traversal are not yet active retrieval features.
- Existing live databases may hold older artifacts until a fresh ingest rewrites them with the new metadata contract.
- Some legacy large XLSX files still exceed payload limits and remain a separate reliability concern outside this PDF-focused change.
