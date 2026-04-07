from __future__ import annotations

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
            "parse_lane": "local_pypdf",
            PDF_WINDOW_METADATA_KEY: "windowed text",
            PDF_ORIGINAL_TEXT_METADATA_KEY: "full original text",
        },
    )

    payload = workflows.build_qdrant_payload(document, artifact)

    assert payload["text"] == "windowed text"
    assert payload["metadata"]["page_start"] == 3
    assert payload["metadata"]["parse_lane"] == "local_pypdf"
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
