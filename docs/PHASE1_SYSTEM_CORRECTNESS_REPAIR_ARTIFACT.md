# Phase 1 GhostDASH System Correctness Repair Artifact

## Scope

Phase 1 repairs the PDF lane correctness gap where uploads forced operators to pick `local` or `cloud` even though runtime defaults already exposed `pdf_parse_lane_policy` values of `local_default`, `cloud_default`, and `auto`.

The purpose of this phase is to make the architecture honest:

- uploads may explicitly override with `local` or `cloud`
- uploads may also choose `default`
- `default` defers PDF behavior to the runtime policy instead of silently hard-coding a lane at upload time

## Problem Statement

Before this repair:

- the upload surface treated `requested_lane` as `local | cloud`
- runtime already carried richer PDF policy defaults
- the local PDF fallback gate was too weak and mainly keyed off total extracted characters
- operators could believe the runtime policy mattered while the upload choice had already made that policy mostly toothless

This created architectural duplication and made the system less explainable.

## Files Changed

- `backend/src/ghostdash_api/control_api.py`
- `backend/src/ghostdash_api/ingest.py`
- `backend/src/ghostdash_api/models.py`
- `backend/src/ghostdash_api/schemas.py`
- `backend/src/ghostdash_api/workflows.py`
- `backend/tests/test_pdf_parse_policy.py`
- `ui/src/api.ts`
- `ui/src/components/AppLayout.tsx`
- `ui/src/components/FullScreenLoader.tsx`
- `ui/src/components/IngestionHistory.tsx`
- `ui/src/components/UploadArea.tsx`
- `ui/src/pages/Dashboard.tsx`
- `ui/src/pages/DataSourcesPage.tsx`

## Implemented Semantics

### Requested lane contract

- `default`: defer PDF routing to runtime `pdf_parse_lane_policy`
- `local`: force local-only PDF parsing
- `cloud`: force cloud-only PDF parsing

### Effective PDF policy behavior

- `requested_lane == cloud`: cloud only, fail if cloud is unavailable or returns no usable text
- `requested_lane == local`: local only, fail if local extraction is not trustworthy
- `requested_lane == default` plus `local_default`: local only
- `requested_lane == default` plus `cloud_default`: cloud first, then local fallback only when cloud is unavailable or cloud parsing fails
- `requested_lane == default` plus `auto`: local first, then cloud fallback only when the deterministic local quality gate rejects the extraction and cloud is available

### Non-PDF behavior

Phase 1 intentionally keeps non-PDF behavior simple:

- `cloud` remains an explicit override for formats already supporting cloud parsing
- `default` currently falls back to existing local parsing behavior for non-PDFs

This keeps the repair focused on the PDF correctness path without inventing a second policy system for non-PDF documents.

## Deterministic Local PDF Quality Gate

The local PDF gate now evaluates more than a raw character floor. It records and uses:

- total extracted characters
- total token count
- substantive page count and page numbers
- low-signal page count and page numbers
- garbage page count and page numbers
- repeated header/footer cleanup activity and affected page numbers
- explicit fallback reason codes

Current fallback reason codes include:

- `total_text_chars_below_floor`
- `total_tokens_below_floor`
- `no_substantive_pages`
- `all_pages_low_signal`
- `low_signal_pages_dominate`
- `garbage_pages_dominate`
- `local_parse_error`

## Persisted Diagnostics Contract

Successful PDF ingests now persist a structured diagnostics block in `document.metadata_json` under:

- `pdf_parse_diagnostics`

The diagnostics object includes:

- `requested_lane`
- `parse_lane_policy`
- `decision`
- `fallback_reasons`
- `selected_parse_lane`
- `local`
- `cloud`

The `local` section captures quality and cleanup metrics. The `cloud` section captures availability, attempt status, success, parse lane, text size, and error when applicable.

This keeps requested versus actual parse behavior explainable after ingestion rather than only during runtime execution.

## Architecture Decisions

### 1. Runtime policy owns default PDF behavior

The upload surface no longer forces a policy decision on every file. Operators can leave a PDF on `default`, and the runtime policy becomes the actual source of default routing truth.

### 2. Actual parse lanes stay honest

The system still persists actual execution lanes such as:

- `local_pypdf`
- `llamaparse`
- `local_xlsx`

The repair does not collapse execution telemetry into vague labels like `local` or `cloud`.

### 3. Diagnostics are stored on the document, not inferred later

This avoids a future bug class where the UI can show only the final lane without the reason why the system chose it.

### 4. Preserve current citation and inventory work

This phase does not change the retrieval artifact contract for citations or document inventory. It only makes the requested-versus-actual parsing story correct and auditable.

## Verification Performed

### Passed

- `python3.12 -m compileall src` in `backend/`
- `npm run lint` in `ui/`
- `npm run build -- --outDir /tmp/ghostdash-ui-build` in `ui/`
- direct backend runtime assertions in an ephemeral container with the current backend tree mounted read-only

### Blocked or environment-limited

- host-side `pytest` collection was blocked because the host Python environment is missing backend runtime packages such as `tiktoken` and `psycopg`
- the running `ghoststack-rag-control-api-1` container has backend dependencies but does not ship `pytest`
- browser-based human QA against the currently served GhostDASH app showed the old Data Sources lane picker (`local/cloud` only), which indicates the live stack is still serving a pre-change build and has not been rebuilt from this repo state yet

## Human QA Finding

The live UI at `https://ghoststack.rideai.com.au/data-sources` still presents:

- `Local parse lane`
- `Cloud (LlamaParse)`

and does not yet show:

- `Default (runtime policy)`

That is not a code regression in this change set. It is an operational drift signal: the running stack is not built from the current repo state. Rebuild and restart are required before live human QA can validate the new surface.

## Acceptance Criteria

- uploads can request `default`, `local`, or `cloud`
- PDF runtime policy controls behavior only when the request is `default`
- explicit `local` and `cloud` requests bypass runtime default routing as overrides
- local PDF extraction uses a deterministic trust gate rather than a single-character threshold
- PDF document metadata persists parse diagnostics explaining requested, attempted, and actual behavior
- requested versus actual lanes are shown separately in the touched UI status surfaces
- actual execution lanes remain concrete lane values such as `local_pypdf` and `llamaparse`

## Exact Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag
git status -sb
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker logs --tail=120 ghoststack-rag-control-api-1
docker logs --tail=120 ghoststack-rag-workflow-runtime-1

cd /var/llamaindex/ghoststack-rag/backend
python3.12 -m compileall src
PYTHONPATH=src python3.12 -m pytest tests/test_pdf_parse_policy.py tests/test_ingestion_qdrant_batching.py tests/test_runtime_profiles.py

cd /var/llamaindex/ghoststack-rag/ui
npm run lint
npm run build -- --outDir /tmp/ghostdash-ui-build
```

If host Python is still missing backend packages, use a dependency-ready container for direct runtime assertions against the mounted source tree:

```bash
cd /var/llamaindex/ghoststack-rag
docker run --rm -v "/var/llamaindex/ghoststack-rag/backend:/app:ro" -w /app ghoststack-rag-control-api python - <<'PY'
import sys
sys.path.insert(0, '/app/src')
from ghostdash_api import ingest
print('backend import ok:', hasattr(ingest, 'extract_pdf_documents'))
PY
```

## Human Retest Request

After rebuilding the stack from the current repo state, test the flow as an operator:

1. Open `Data Sources` and confirm the upload selector offers `Default (runtime policy)`, `Local only`, and `Cloud only`.
2. Set runtime `pdf_parse_lane_policy` to `local_default`, upload a PDF with `Default`, and confirm the resulting document shows `requested: Default (runtime policy)` and `actual: local_pypdf`.
3. Set runtime `pdf_parse_lane_policy` to `cloud_default`, upload a PDF with `Default`, and confirm the resulting document shows a cloud actual lane when cloud is available.
4. Set runtime `pdf_parse_lane_policy` to `auto`, upload a difficult PDF with `Default`, and confirm cloud fallback occurs only when the local diagnostics reject the extraction.
5. Upload one PDF with explicit `Local only` and one with explicit `Cloud only` and confirm those requests override the runtime default.

## Residual Risk

- until the stack is rebuilt, browser-based human QA will keep reflecting stale live code rather than this change set
- host Python still lacks the backend packages required for full local `pytest` execution
- non-PDF `default` behavior intentionally remains simple local behavior in this phase; if future requirements want runtime-owned defaults for more formats, that should be designed explicitly instead of inferred
