from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from ghostdash_api.ingest import PDF_ORIGINAL_TEXT_METADATA_KEY, PDF_WINDOW_METADATA_KEY
from ghostdash_api import workflows


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
    class DummySessionContext:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(workflows, "SessionLocal", lambda: DummySessionContext())
    monkeypatch.setattr(workflows, "get_active_connection", lambda session, provider: object())
    monkeypatch.setattr(
        workflows,
        "get_default_runtime_profile",
        lambda session: SimpleNamespace(kb_config_json={"embedding_model_id": "openai/text-embedding-3-small"}),
    )
    monkeypatch.setattr(workflows, "find_structured_candidates", lambda message, corpora: [])
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
    assert plan["citations"][0]["section_title"] == "Pricing"
    assert plan["citations"][0]["section_path"] == "Overview > Pricing"
    assert plan["citations"][0]["heading_level"] == 2
