from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from ghostdash_api.ingest import PDF_ORIGINAL_TEXT_METADATA_KEY, PDF_WINDOW_METADATA_KEY
from ghostdash_api import workflows
from ghostdash_api.database import Base
from ghostdash_api.models import DocumentRecord, IngestionRunRecord, RetrievalArtifactRecord


class DummySessionContext:
    def __enter__(self):
        return object()

    def __exit__(self, exc_type, exc, tb):
        return False


def configure_query_plan_runtime(monkeypatch) -> None:
    monkeypatch.setattr(workflows, "SessionLocal", lambda: DummySessionContext())
    monkeypatch.setattr(workflows, "get_active_connection", lambda session, provider: object())
    monkeypatch.setattr(
        workflows,
        "get_default_runtime_profile",
        lambda session: SimpleNamespace(kb_config_json={"embedding_model_id": "openai/text-embedding-3-small"}),
    )
    monkeypatch.setattr(workflows, "find_structured_candidates", lambda message, corpora: [])


def make_semantic_hit(
    *,
    document_id: str,
    filename: str,
    text: str,
    score: float,
    chunk_index: int,
    corpus: str = "default",
    source_path: str | None = None,
    artifact_type: str = "chunk",
    page_start: int | None = None,
    page_end: int | None = None,
    section_title: str | None = None,
    section_path: str | None = None,
    heading_level: int | None = None,
    parse_lane: str | None = "local_pypdf",
) -> dict[str, object]:
    metadata: dict[str, object] = {}
    if page_start is not None:
        metadata["page_start"] = page_start
    if page_end is not None:
        metadata["page_end"] = page_end
    if section_title is not None:
        metadata["section_title"] = section_title
    if section_path is not None:
        metadata["section_path"] = section_path
    if heading_level is not None:
        metadata["heading_level"] = heading_level
    if parse_lane is not None:
        metadata["parse_lane"] = parse_lane
    return {
        "score": score,
        "text": text,
        "document_id": document_id,
        "filename": filename,
        "corpus": corpus,
        "artifact_type": artifact_type,
        "source_path": source_path or f"/tmp/{filename}",
        "chunk_index": chunk_index,
        "page_start": page_start,
        "page_end": page_end,
        "section_title": section_title,
        "section_path": section_path,
        "heading_level": heading_level,
        "parse_lane": parse_lane,
        "metadata": metadata,
    }


def test_build_qdrant_payload_strips_large_pdf_metadata() -> None:
    document = SimpleNamespace(
        id="doc-1",
        filename="large.pdf",
        corpus="default",
        source_path="/tmp/large.pdf",
    )
    artifact = SimpleNamespace(
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

    payload = workflows.build_qdrant_payload(document, artifact)

    assert payload["text"] == "windowed text"
    assert payload["metadata"]["page_start"] == 3
    assert payload["metadata"]["parse_lane"] == "local_pypdf"
    assert payload["section_path"] == "Overview > Pricing"
    assert payload["heading_level"] == 2
    assert PDF_WINDOW_METADATA_KEY not in payload["metadata"]
    assert PDF_ORIGINAL_TEXT_METADATA_KEY not in payload["metadata"]


def test_build_qdrant_upsert_batches_splits_oversized_requests(monkeypatch) -> None:
    monkeypatch.setattr(workflows, "QDRANT_UPSERT_MAX_BYTES", 450)
    monkeypatch.setattr(workflows, "QDRANT_UPSERT_MAX_POINTS", 10)

    payloads = [
        {"text": "a" * 160, "metadata": {"chunk_index": idx}}
        for idx in range(3)
    ]
    vectors = [[0.1, 0.2, 0.3] for _ in payloads]

    batches = workflows.build_qdrant_upsert_batches(payloads, vectors)

    assert len(batches) == 3
    assert [len(batch_payloads) for batch_payloads, _, _ in batches] == [1, 1, 1]
    assert sum(len(batch_payloads) for batch_payloads, _, _ in batches) == 3


def test_build_run_failure_message_distinguishes_parse_and_index_failures() -> None:
    assert workflows.build_run_failure_message(parse_failed=0, index_failed=0) is None
    assert workflows.build_run_failure_message(parse_failed=0, index_failed=2) == "2 document(s) failed during indexing"
    assert workflows.build_run_failure_message(parse_failed=3, index_failed=0) == "3 document(s) failed during parsing"
    assert (
        workflows.build_run_failure_message(parse_failed=2, index_failed=1)
        == "3 document(s) failed during ingestion (2 during parsing, 1 during indexing)"
    )


def test_persist_text_retrieval_artifacts_preserves_markdown_section_titles(monkeypatch) -> None:
    monkeypatch.setattr(workflows.settings, "app_chunk_size", 90)
    monkeypatch.setattr(workflows.settings, "app_chunk_overlap", 10)

    document = SimpleNamespace(
        id="doc-1",
        filename="guide.md",
        corpus="default",
        source_path="/tmp/guide.md",
        source_kind="document",
    )
    version = SimpleNamespace(
        id="version-1",
        version_hash="hash-1",
        created_at=datetime.now(UTC),
    )
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
        document=document,
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
    assert any(artifact.metadata_json["section_title"] == "Pricing" for artifact in artifacts)
    assert any(artifact.metadata_json["section_path"] == "Overview > Pricing" for artifact in artifacts)
    assert any(artifact.metadata_json["heading_level"] == 2 for artifact in artifacts)
    assert all("chunk_index" in artifact.metadata_json for artifact in artifacts)


def test_build_query_plan_semantic_citations_include_structure_metadata(monkeypatch) -> None:
    configure_query_plan_runtime(monkeypatch)
    monkeypatch.setattr(workflows, "embed_texts", lambda *args, **kwargs: [[0.1, 0.2, 0.3]])
    monkeypatch.setattr(
        workflows,
        "search_vectors",
        lambda *args, **kwargs: [
            {
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
            }
        ],
    )

    plan = workflows.build_query_plan(
        message="Summarize the pricing section",
        corpora=["default"],
        top_k=4,
        trace_id="trace-1",
    )

    assert plan["query_mode"] == "semantic"
    assert plan["direct_answer"] is None
    assert "filename=guide.md" in plan["prompt"]
    assert "source_path=/tmp/guide.md" in plan["prompt"]
    assert "Retrieved text:\nPricing overview chunk" in plan["prompt"]
    assert plan["citations"][0]["section_title"] == "Pricing"
    assert plan["citations"][0]["section_path"] == "Overview > Pricing"
    assert plan["citations"][0]["heading_level"] == 2


def test_build_query_plan_filename_targeting_filters_primary_semantic_context_to_target_document(monkeypatch) -> None:
    configure_query_plan_runtime(monkeypatch)
    monkeypatch.setattr(workflows, "embed_texts", lambda *args, **kwargs: [[0.1, 0.2, 0.3]])

    global_hits = [
        make_semantic_hit(
            document_id="doc-target",
            filename="2026-PARTNER-TRENDS-MASTER.pdf",
            text="Global summary chunk",
            score=0.83,
            chunk_index=0,
            page_start=1,
            section_title="Executive summary",
            section_path="Executive summary",
        ),
        make_semantic_hit(
            document_id="doc-other",
            filename="competitor-brief.pdf",
            text="Competitor context chunk",
            score=0.82,
            chunk_index=0,
            page_start=2,
            section_title="Competition",
            section_path="Competition",
        ),
        make_semantic_hit(
            document_id="doc-target",
            filename="2026-PARTNER-TRENDS-MASTER.pdf",
            text="Global methods chunk",
            score=0.79,
            chunk_index=1,
            page_start=3,
            section_title="Methods",
            section_path="Methods",
        ),
        make_semantic_hit(
            document_id="doc-third",
            filename="regional-notes.md",
            text="Regional notes chunk",
            score=0.76,
            chunk_index=0,
            section_title="Regional notes",
            section_path="Regional notes",
            parse_lane="llamaparse",
        ),
    ]
    expansion_hits = [
        global_hits[0],
        make_semantic_hit(
            document_id="doc-target",
            filename="2026-PARTNER-TRENDS-MASTER.pdf",
            text="Expansion detail A",
            score=0.75,
            chunk_index=2,
            page_start=6,
            section_title="Regional trends",
            section_path="Regional trends",
        ),
        make_semantic_hit(
            document_id="doc-target",
            filename="2026-PARTNER-TRENDS-MASTER.pdf",
            text="Expansion detail B",
            score=0.74,
            chunk_index=3,
            page_start=8,
            section_title="Forecast",
            section_path="Forecast",
        ),
    ]
    search_calls: list[dict[str, object]] = []

    def fake_search(vector, corpora, top_k, document_ids=None, **kwargs):
        search_calls.append(
            {
                "corpora": list(corpora),
                "top_k": top_k,
                "document_ids": list(document_ids) if document_ids is not None else None,
            }
        )
        if document_ids is not None:
            return expansion_hits
        return global_hits

    monkeypatch.setattr(workflows, "search_vectors", fake_search)

    plan = workflows.build_query_plan(
        message="In 2026-PARTNER-TRENDS-MASTER.pdf, what are the main partner trends?",
        corpora=["default"],
        top_k=4,
        trace_id="trace-1",
    )

    assert len(search_calls) == 2
    assert search_calls[0]["document_ids"] is None
    assert search_calls[1]["document_ids"] == ["doc-target"]
    assert search_calls[1]["top_k"] > 4
    assert plan["query_mode"] == "semantic"
    assert plan["prompt"] is not None
    assert "Document-scoped expansion:" in plan["prompt"]
    assert "Target document: filename=2026-PARTNER-TRENDS-MASTER.pdf" in plan["prompt"]
    assert "selection_reason=filename mention" in plan["prompt"]
    assert "competitor-brief.pdf" not in plan["prompt"]
    assert "Competitor context chunk" not in plan["prompt"]
    assert "regional-notes.md" not in plan["prompt"]
    assert "Regional notes chunk" not in plan["prompt"]
    assert "Expansion detail A" in plan["prompt"]
    assert "Expansion detail B" in plan["prompt"]
    assert plan["prompt"].count("Global summary chunk") == 1
    assert {citation["filename"] for citation in plan["citations"]} == {"2026-PARTNER-TRENDS-MASTER.pdf"}
    assert len(plan["citations"]) == 4


def test_build_query_plan_document_dominance_adds_document_scoped_expansion(monkeypatch) -> None:
    configure_query_plan_runtime(monkeypatch)
    monkeypatch.setattr(workflows, "embed_texts", lambda *args, **kwargs: [[0.1, 0.2, 0.3]])

    global_hits = [
        make_semantic_hit(
            document_id="doc-dominant",
            filename="partner-outlook.pdf",
            text="Outlook summary chunk",
            score=0.95,
            chunk_index=0,
            page_start=1,
            section_title="Outlook",
            section_path="Outlook",
        ),
        make_semantic_hit(
            document_id="doc-dominant",
            filename="partner-outlook.pdf",
            text="Channel strategy chunk",
            score=0.91,
            chunk_index=1,
            page_start=4,
            section_title="Channel strategy",
            section_path="Channel strategy",
        ),
        make_semantic_hit(
            document_id="doc-dominant",
            filename="partner-outlook.pdf",
            text="Demand forecast chunk",
            score=0.89,
            chunk_index=2,
            page_start=7,
            section_title="Demand forecast",
            section_path="Demand forecast",
        ),
        make_semantic_hit(
            document_id="doc-other",
            filename="sales-notes.pdf",
            text="Sales notes chunk",
            score=0.52,
            chunk_index=0,
            page_start=2,
            section_title="Sales notes",
            section_path="Sales notes",
        ),
    ]
    expansion_hits = [
        global_hits[1],
        make_semantic_hit(
            document_id="doc-dominant",
            filename="partner-outlook.pdf",
            text="Expansion demand detail",
            score=0.84,
            chunk_index=4,
            page_start=9,
            section_title="Detailed outlook",
            section_path="Detailed outlook",
        ),
    ]
    search_calls: list[dict[str, object]] = []

    def fake_search(vector, corpora, top_k, document_ids=None, **kwargs):
        search_calls.append(
            {
                "corpora": list(corpora),
                "top_k": top_k,
                "document_ids": list(document_ids) if document_ids is not None else None,
            }
        )
        if document_ids is not None:
            return expansion_hits
        return global_hits

    monkeypatch.setattr(workflows, "search_vectors", fake_search)

    plan = workflows.build_query_plan(
        message="Summarize the partner market outlook",
        corpora=["default"],
        top_k=4,
        trace_id="trace-1",
    )

    assert len(search_calls) == 2
    assert search_calls[1]["document_ids"] == ["doc-dominant"]
    assert search_calls[1]["top_k"] > 4
    assert plan["prompt"] is not None
    assert "Document-scoped expansion:" in plan["prompt"]
    assert "Target document: filename=partner-outlook.pdf" in plan["prompt"]
    assert "selection_reason=document dominance" in plan["prompt"]
    assert "Expansion demand detail" in plan["prompt"]
    assert len(plan["citations"]) == 5


def test_build_query_plan_document_inventory_questions_use_manifest(monkeypatch) -> None:
    configure_query_plan_runtime(monkeypatch)

    monkeypatch.setattr(
        workflows,
        "select_documents_for_corpora",
        lambda session, corpora: [
            SimpleNamespace(
                id="doc-1",
                filename="426038-PDF-ENG.pdf",
                corpus="re-finance-080526",
                source_path="/data/uploads/re-finance-080526/426038-PDF-ENG.pdf",
                actual_parse_lane="local_pypdf",
                parse_status="completed",
                index_status="completed",
                metadata_json={},
            ),
            SimpleNamespace(
                id="doc-2",
                filename="aged_receivable.xlsx",
                corpus="re-finance-080526",
                source_path="/data/uploads/re-finance-080526/aged_receivable.xlsx",
                actual_parse_lane="local_xlsx",
                parse_status="completed",
                index_status="completed",
                metadata_json={},
            ),
        ],
    )

    def fail_embed(*args, **kwargs):
        raise AssertionError("inventory listing should not require embeddings")

    monkeypatch.setattr(workflows, "embed_texts", fail_embed)

    plan = workflows.build_query_plan(
        message="What files are in this corpus?",
        corpora=["re-finance-080526"],
        top_k=4,
        trace_id="trace-1",
    )

    assert plan["query_mode"] == "semantic"
    assert plan["prompt"] is None
    assert "426038-PDF-ENG.pdf" in plan["direct_answer"]
    assert "aged_receivable.xlsx" in plan["direct_answer"]
    assert plan["citations"][0]["artifact_type"] == "document_manifest"


def test_build_query_plan_ignores_history_prefixed_inventory_phrases_when_current_message_is_analysis(monkeypatch) -> None:
    configure_query_plan_runtime(monkeypatch)
    monkeypatch.setattr(workflows, "embed_texts", lambda *args, **kwargs: [[0.1, 0.2, 0.3]])
    monkeypatch.setattr(
        workflows,
        "search_vectors",
        lambda *args, **kwargs: [
            make_semantic_hit(
                document_id="doc-ride-electric",
                filename="GREEN WHEELS LANKA.CONCEPT NOTE.V1.docx",
                text="Ride Electric financial model assumes manufacturing could shift from China to Sri Lanka.",
                score=0.91,
                chunk_index=0,
                section_title="Financial model",
                section_path="Financial model",
                parse_lane="local_docx",
            )
        ],
    )
    monkeypatch.setattr(
        workflows,
        "select_documents_for_corpora",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("history text must not trigger inventory listing")),
    )

    plan = workflows.build_query_plan(
        message=(
            "Recent conversation memory:\n"
            "Assistant: In the current document inventory, I can see SriLanka.pdf.\n\n"
            "Current user request:\n"
            "Utilise financials for the business within your context."
        ),
        current_message="Utilise financials for the business within your context.",
        corpora=["re-finance26"],
        top_k=4,
        trace_id="trace-1",
    )

    assert plan["direct_answer"] is None
    assert plan["prompt"] is not None
    assert "Ride Electric financial model" in plan["prompt"]
    assert "document inventory" not in plan["prompt"].lower()


def test_index_retrieval_logs_original_embedding_failure_before_first_upsert_batch(monkeypatch) -> None:
    engine = create_engine("sqlite:///:memory:", future=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(workflows, "SessionLocal", SessionLocal)
    monkeypatch.setattr(workflows, "delete_document_vectors", lambda *args, **kwargs: None)
    monkeypatch.setattr(workflows, "get_active_connection", lambda session, provider: object())
    monkeypatch.setattr(
        workflows,
        "get_default_runtime_profile",
        lambda session: SimpleNamespace(
            kb_config_json={"embedding_model_id": "openai/intfloat/multilingual-e5-large-instruct"}
        ),
    )

    def fail_embed(*args, **kwargs):
        raise ValueError("batch size 100 > maximum allowed batch size 8")

    events: list[dict] = []

    monkeypatch.setattr(workflows, "embed_texts", fail_embed)
    monkeypatch.setattr(workflows, "log_instant_event", lambda **kwargs: events.append(kwargs))

    with SessionLocal() as session:
        run = IngestionRunRecord(
            id="run-1",
            corpus="partner-trends-regression",
            status="running",
            current_step="index_retrieval",
            progress=0.6,
            result_json={
                "documents_failed": 0,
                "documents_parse_failed": 0,
                "documents_indexed": 0,
            },
        )
        document = DocumentRecord(
            id="doc-1",
            corpus="partner-trends-regression",
            filename="2026-PARTNER-TRENDS-MASTER.pdf",
            source_path="/tmp/2026-PARTNER-TRENDS-MASTER.pdf",
            requested_lane="default",
            actual_parse_lane="local_pypdf",
            parse_status="completed",
            index_status="pending",
            status="parsed",
            metadata_json={"pdf_parse_diagnostics": {"decision": "default_auto_local_accepted"}},
        )
        artifact = RetrievalArtifactRecord(
            id="artifact-1",
            document_id=document.id,
            corpus=document.corpus,
            artifact_type="pdf_sentence_window",
            text="Partner trends chunk",
            metadata_json={PDF_ORIGINAL_TEXT_METADATA_KEY: "Partner trends chunk"},
        )
        session.add_all([run, document, artifact])
        session.commit()

    event = workflows.RetrievalPreparedEvent(run_id="run-1", trace_id="trace-1", document_ids=["doc-1"])
    asyncio.run(workflows.IngestionWorkflow().index_retrieval(event))

    with SessionLocal() as session:
        refreshed_run = session.get(IngestionRunRecord, "run-1")
        refreshed_document = session.get(DocumentRecord, "doc-1")

    assert refreshed_run is not None
    assert refreshed_document is not None
    assert refreshed_run.status == "failed"
    assert refreshed_run.result_json["documents_failed"] == 1
    assert refreshed_run.result_json["documents_index_failed"] == 1
    assert refreshed_document.index_status == "failed"
    assert refreshed_document.status == "error"
    assert refreshed_document.error_message == "batch size 100 > maximum allowed batch size 8"

    failed_event = next(event for event in events if event["route"] == "ingestion.index.failed")
    assert failed_event["error"] == "ValueError('batch size 100 > maximum allowed batch size 8')"
    assert failed_event["details"]["document_id"] == "doc-1"
    assert failed_event["details"]["batch_index"] is None
    assert failed_event["details"]["batch_points"] == 0
    assert failed_event["details"]["estimated_request_bytes"] == 0
