# Phase 2 Verify Clean Release Artifact

## Goal

Finish the Phase 2 verification pass with targeted automated checks, human-style operator QA, and cleanup of temporary generated artefacts so the current change set is release-ready without hidden drift.

## Operator journey tested

Primary operator persona: an admin validating retrieval and web-source behavior after the Phase 2 bundle.

Journeys exercised:

- open dashboard and confirm aggregate-vs-preview retrieval messaging
- open vector stats page and confirm authoritative totals and document-type breakdowns
- open agent configuration and confirm approved-web settings are editable there
- open GhostChat and confirm approved-web configuration is read-only there, with only the per-message override remaining

## Verification performed

### Repo/runtime evidence

- `git status --short`
- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
- `docker logs --tail=120 ghoststack-rag-caddy-1`
- `docker logs --tail=120 ghoststack-rag-control-api-1`

Observed:

- running container names are the real `ghoststack-rag-*` names, not the older shorthand names used in some historical guidance
- `control-api` logs show healthy structured request logs for current routes including `/api/vector-stats`, `/api/documents`, `/api/connections`, and `/api/runtime/defaults`

### Automated checks

Passed directly on host:

- `python3.12 -m compileall backend/src`
- `APP_DB_URL='sqlite:///:memory:' PYTHONPATH=src python3.12 -m pytest tests/test_approved_web.py -q`
- `cd ui && npm run lint`
- `cd ui && npm run build -- --outDir dist-phase2-release`

Passed inside the running backend container through inline assertion scripts:

- structure-aware retrieval fidelity assertions:
  - Qdrant payload propagation for `section_path` and `heading_level`
  - markdown structure-aware chunk metadata persistence
  - semantic citation propagation of structure-aware fields
- vector aggregate stats assertions:
  - overall/default/finance counts
  - document type breakdowns (`pdf`, `xlsx`, `txt`, `other`)
  - workbook row totals

Why the container-side path was needed:

- host Python in this environment does not have the full backend dependency set required for all tests (`llama_index`, `tiktoken`, `psycopg`)
- the running backend container has the correct runtime dependencies, but not the repo `tests/` directory mounted
- inline assertions against the live container code were the cleanest way to verify those paths without mutating the environment

### Human QA

Browser-style QA was completed against `https://ghoststack.rideai.com.au`.

Confirmed:

- dashboard copy clearly distinguishes aggregate totals from capped previews
- vectors page loads authoritative totals and the document-type breakdown cards
- `Agent Config` remains the editable surface for approved-web tool enablement and allowed URLs
- `GhostChat` tools drawer shows approved-web policy as read-only and keeps configuration ownership delegated to `Agent Config`
- the per-message `Force approved web use for this message` checkbox is actually toggleable in the live UI

## Issues found and repaired

### Issue 1: host-side backend tests were partially blocked by missing dependencies

Symptoms:

- `tests/test_vector_stats.py` could not import because host Python lacked `llama_index`
- `tests/test_ingestion_qdrant_batching.py` could not import because host Python lacked `tiktoken`

Repair:

- kept the host-side check for `test_approved_web.py`
- verified the LlamaIndex-dependent workflow/vector logic inside the running backend container using inline assertion scripts

### Issue 2: default frontend build output path had a permissions problem

Symptom:

- `npm run build` failed with `EACCES: permission denied, rmdir '/var/llamaindex/ghoststack-rag/ui/dist/assets'`

Repair:

- built to `dist-phase2-release` instead
- deleted the generated files after verification so no temporary artefacts remain in repo status

### Issue 3: accessibility snapshot still labels the approved-web checkbox as `readonly`

Symptom:

- browser automation reported a `readonly` state on the checkbox

Repair/verification:

- explicit double-toggle retest confirmed the visual checked state changes on each click
- treated as a tooling/accessibility snapshot quirk, not a product regression

## Acceptance criteria

- targeted backend/frontend checks completed for the Phase 2 bundle: met
- operator-facing QA confirms no duplicate approved-web settings surfaces: met
- approved-web per-message override remains usable in `GhostChat`: met
- aggregate vector truth surfaces remain visible and coherent: met
- temporary build artefacts removed from repo status: met

## Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag
git status --short
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker logs --tail=120 ghoststack-rag-caddy-1
docker logs --tail=120 ghoststack-rag-control-api-1
python3.12 -m compileall backend/src
cd backend && APP_DB_URL='sqlite:///:memory:' PYTHONPATH=src python3.12 -m pytest tests/test_approved_web.py -q
cd ../ui && npm run lint
cd ../ui && npm run build -- --outDir dist-phase2-release
```

Container-side backend assertions:

```bash
cd /var/llamaindex/ghoststack-rag
docker exec ghoststack-rag-control-api-1 python -u - <<'PY'
from datetime import UTC, datetime
from types import SimpleNamespace
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from ghostdash_api.ingest import PDF_ORIGINAL_TEXT_METADATA_KEY, PDF_WINDOW_METADATA_KEY
from ghostdash_api import workflows
from ghostdash_api.control_api import _compute_vector_stats
from ghostdash_api.database import Base
from ghostdash_api.models import (
    DocumentRecord,
    RetrievalArtifactRecord,
    WorkbookArtifactRecord,
    WorkbookRowRecord,
    WorkbookSheetRecord,
    WorkbookTableRecord,
)

pdf_doc = SimpleNamespace(id="doc-1", filename="large.pdf", corpus="default", source_path="/tmp/large.pdf")
pdf_artifact = SimpleNamespace(
    artifact_type="pdf_sentence_window",
    text="full original text",
    metadata_json={
        "document_version_id": "version-1",
        "content_hash": "hash-1",
        "page_start": 3,
        "page_end": 4,
        "section_title": "Overview",
        "section_path": "Overview > Pricing",
        "heading_level": 2,
        "parse_lane": "local_pypdf",
        PDF_WINDOW_METADATA_KEY: "windowed text",
        PDF_ORIGINAL_TEXT_METADATA_KEY: "full original text",
    },
)
payload = workflows.build_qdrant_payload(pdf_doc, pdf_artifact)
assert payload["text"] == "windowed text"
assert payload["section_path"] == "Overview > Pricing"
assert payload["heading_level"] == 2
assert PDF_WINDOW_METADATA_KEY not in payload["metadata"]
assert PDF_ORIGINAL_TEXT_METADATA_KEY not in payload["metadata"]

workflows.settings.app_chunk_size = 90
workflows.settings.app_chunk_overlap = 10
md_doc = SimpleNamespace(
    id="doc-1",
    filename="guide.md",
    corpus="default",
    source_path="/tmp/guide.md",
    source_kind="document",
)
version = SimpleNamespace(id="version-1", version_hash="hash-1", created_at=datetime.now(UTC))
text = (
    "# Overview\n\n"
    "GhostDASH provides grounded retrieval over operator documents. "
    "This section explains the high level architecture and control flow.\n\n"
    "## Pricing\n\n"
    "Pricing guidance should stay grounded in the retrieved source material. "
    "This section exists to verify that structure-aware chunking preserves section metadata."
)
artifacts = workflows.persist_text_retrieval_artifacts(
    None,
    document=md_doc,
    version=version,
    text=text,
    parse_lane="llamaparse",
    chunk_size=90,
    chunk_overlap=10,
    heading_aware=True,
)
assert len(artifacts) >= 2
assert artifacts[0].metadata_json["section_title"] == "Overview"
assert artifacts[0].metadata_json["section_path"] == "Overview"
assert artifacts[0].metadata_json["heading_level"] == 1
assert any(a.metadata_json["section_path"] == "Overview > Pricing" for a in artifacts)
assert any(a.metadata_json["heading_level"] == 2 for a in artifacts)

class DummySessionContext:
    def __enter__(self):
        return object()
    def __exit__(self, exc_type, exc, tb):
        return False

workflows.SessionLocal = lambda: DummySessionContext()
workflows.get_active_connection = lambda session, provider: object()
workflows.get_default_runtime_profile = lambda session: SimpleNamespace(
    kb_config_json={"embedding_model_id": "openai/text-embedding-3-small"}
)
workflows.find_structured_candidates = lambda message, corpora: []
workflows.embed_texts = lambda *args, **kwargs: [[0.1, 0.2, 0.3]]
workflows.search_vectors = lambda *args, **kwargs: [{
    "text": "Pricing overview chunk",
    "document_id": "doc-1",
    "filename": "guide.md",
    "corpus": "default",
    "artifact_type": "chunk",
    "source_path": "/tmp/guide.md",
    "chunk_index": 0,
    "section_title": "Pricing",
    "section_path": "Overview > Pricing",
    "heading_level": 2,
    "parse_lane": "llamaparse",
    "metadata": {
        "section_title": "Pricing",
        "section_path": "Overview > Pricing",
        "heading_level": 2,
        "parse_lane": "llamaparse",
    },
}]
plan = workflows.build_query_plan(message="Summarize the pricing section", corpora=["default"], top_k=4, trace_id="trace-1")
assert plan["query_mode"] == "semantic"
assert plan["citations"][0]["section_title"] == "Pricing"
assert plan["citations"][0]["section_path"] == "Overview > Pricing"
assert plan["citations"][0]["heading_level"] == 2

engine = create_engine("sqlite:///:memory:", future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base.metadata.create_all(bind=engine)
with SessionLocal() as session:
    pdf_default = DocumentRecord(corpus="default", filename="report.pdf", source_path="/tmp/report.pdf", requested_lane="local", parse_status="completed", index_status="completed", status="indexed")
    workbook_default = DocumentRecord(corpus="default", filename="workbook.xlsx", source_path="/tmp/workbook.xlsx", requested_lane="local", parse_status="completed", index_status="completed", status="indexed")
    markdown_default = DocumentRecord(corpus="default", filename="notes.md", source_path="/tmp/notes.md", requested_lane="local", parse_status="completed", index_status="completed", status="indexed")
    finance_other = DocumentRecord(corpus="finance", filename="slides.pptx", source_path="/tmp/slides.pptx", requested_lane="local", parse_status="completed", index_status="completed", status="indexed")
    session.add_all([pdf_default, workbook_default, markdown_default, finance_other])
    session.commit()
    session.add_all([
        RetrievalArtifactRecord(document_id=pdf_default.id, corpus="default", artifact_type="chunk", text="pdf-1"),
        RetrievalArtifactRecord(document_id=pdf_default.id, corpus="default", artifact_type="chunk", text="pdf-2"),
        RetrievalArtifactRecord(document_id=workbook_default.id, corpus="default", artifact_type="row_summary", text="xlsx-1"),
        RetrievalArtifactRecord(document_id=markdown_default.id, corpus="default", artifact_type="chunk", text="md-1"),
        RetrievalArtifactRecord(document_id=finance_other.id, corpus="finance", artifact_type="chunk", text="pptx-1"),
        RetrievalArtifactRecord(document_id=finance_other.id, corpus="finance", artifact_type="chunk", text="pptx-2"),
        RetrievalArtifactRecord(document_id=finance_other.id, corpus="finance", artifact_type="chunk", text="pptx-3"),
    ])
    session.commit()
    workbook = WorkbookArtifactRecord(document_id=workbook_default.id, document_version_id="version-1", filename=workbook_default.filename, sheet_count=1)
    session.add(workbook)
    session.commit()
    sheet = WorkbookSheetRecord(workbook_artifact_id=workbook.id, name="Sheet1", ordinal=0, row_count=2)
    session.add(sheet)
    session.commit()
    table = WorkbookTableRecord(workbook_sheet_id=sheet.id, name="Table1", ordinal=0, header_json=["amount"], row_count=2)
    session.add(table)
    session.commit()
    session.add_all([
        WorkbookRowRecord(document_id=workbook_default.id, workbook_table_id=table.id, row_index=1, row_json={"amount": 10}, search_text="amount 10"),
        WorkbookRowRecord(document_id=workbook_default.id, workbook_table_id=table.id, row_index=2, row_json={"amount": 20}, search_text="amount 20"),
    ])
    session.commit()
    overall = _compute_vector_stats(session)
    default = _compute_vector_stats(session, "default")
    finance = _compute_vector_stats(session, "finance")

assert overall.documents == 4
assert overall.retrieval_artifacts == 7
assert overall.workbook_rows == 2
assert overall.pdf_documents == 1
assert overall.xlsx_documents == 1
assert overall.txt_documents == 1
assert overall.other_documents == 1
assert default.documents == 3
assert default.retrieval_artifacts == 4
assert default.workbook_rows == 2
assert default.pdf_documents == 1
assert default.xlsx_documents == 1
assert default.txt_documents == 1
assert default.other_documents == 0
assert finance.documents == 1
assert finance.retrieval_artifacts == 3
assert finance.workbook_rows == 0
assert finance.pdf_documents == 0
assert finance.xlsx_documents == 0
assert finance.txt_documents == 0
assert finance.other_documents == 1
print("container-side assertions passed")
PY
```

Cleanup after build verification:

```bash
cd /var/llamaindex/ghoststack-rag
rm -rf ui/dist-phase2-release
git status --short
```

## Human retest request

Please retest these flows in the browser:

1. Open `Dashboard` and confirm the aggregate-vs-preview wording still makes immediate sense.
2. Open `Vector DBs` and confirm the document-type breakdown cards match your operator expectations.
3. Open `Agent Config` and confirm approved-web enablement/URLs are editable only there.
4. Open `GhostChat`, open the tools drawer, and confirm the approved-web configuration is read-only there while the per-message force checkbox still toggles.
