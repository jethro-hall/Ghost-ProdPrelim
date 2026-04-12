from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from ghostdash_api import ingest, workflows
from ghostdash_api.ingest import PdfPage


def _weak_local_pages() -> list[PdfPage]:
    return [
        PdfPage(page_number=1, text="A B C", removed_header_lines=1),
        PdfPage(page_number=2, text="$$$ ###", removed_footer_lines=2),
        PdfPage(page_number=3, text="1 2 3"),
    ]


def _strong_local_pages() -> list[PdfPage]:
    return [
        PdfPage(
            page_number=1,
            text=(
                "GhostDASH keeps operator PDF retrieval grounded in source evidence and provenance. "
                "This page contains enough real text to satisfy the deterministic local quality gate. "
            )
            * 8,
        )
    ]


def test_assess_pdf_local_quality_reports_fallback_reasons_and_cleanup() -> None:
    diagnostics = ingest.assess_pdf_local_quality(_weak_local_pages())

    assert diagnostics["trustworthy"] is False
    assert diagnostics["fallback_reasons"] == [
        "total_text_chars_below_floor",
        "total_tokens_below_floor",
        "no_substantive_pages",
        "all_pages_low_signal",
        "garbage_pages_dominate",
    ]
    assert diagnostics["low_signal_pages"] == 3
    assert diagnostics["garbage_pages"] == 3
    assert diagnostics["cleanup_page_numbers"] == [1, 2]
    assert diagnostics["repeated_header_lines_removed"] == 1
    assert diagnostics["repeated_footer_lines_removed"] == 2


def test_extract_pdf_documents_auto_falls_back_to_cloud_when_local_is_not_trustworthy(monkeypatch) -> None:
    monkeypatch.setattr(ingest.settings, "llama_cloud_api_key", "test-key")
    monkeypatch.setattr(ingest, "extract_pdf_pages_local", lambda path: _weak_local_pages())
    monkeypatch.setattr(
        ingest,
        "extract_text_cloud",
        lambda path, tier, trace_id: (
            "# Cloud Parse\n\nGhostDASH cloud parsing recovered clean grounded text.",
            "llamaparse",
        ),
    )

    result = ingest.extract_pdf_documents(
        path=Path("/tmp/sample.pdf"),
        requested_lane="default",
        tier="agentic",
        trace_id="trace-1",
        base_metadata={"filename": "sample.pdf"},
        parse_lane_policy="auto",
    )

    assert result.parse_lane == "llamaparse"
    assert result.parse_diagnostics["decision"] == "default_auto_cloud_fallback"
    assert result.parse_diagnostics["fallback_reasons"] == [
        "total_text_chars_below_floor",
        "total_tokens_below_floor",
        "no_substantive_pages",
        "all_pages_low_signal",
        "garbage_pages_dominate",
    ]
    assert result.parse_diagnostics["local"]["trustworthy"] is False
    assert result.parse_diagnostics["cloud"]["succeeded"] is True
    assert result.parse_diagnostics["selected_parse_lane"] == "llamaparse"


def test_extract_pdf_documents_local_requested_fails_when_local_is_unusable(monkeypatch) -> None:
    monkeypatch.setattr(ingest.settings, "llama_cloud_api_key", "test-key")
    monkeypatch.setattr(ingest, "extract_pdf_pages_local", lambda path: _weak_local_pages())

    cloud_called = False

    def fake_cloud(path, tier, trace_id):
        nonlocal cloud_called
        cloud_called = True
        return "unused", "llamaparse"

    monkeypatch.setattr(ingest, "extract_text_cloud", fake_cloud)

    with pytest.raises(ValueError, match="local pdf parse unusable"):
        ingest.extract_pdf_documents(
            path=Path("/tmp/sample.pdf"),
            requested_lane="local",
            tier="agentic",
            trace_id="trace-1",
            base_metadata={"filename": "sample.pdf"},
            parse_lane_policy="auto",
        )

    assert cloud_called is False


def test_extract_pdf_documents_cloud_default_uses_local_when_cloud_fails(monkeypatch) -> None:
    monkeypatch.setattr(ingest.settings, "llama_cloud_api_key", "test-key")
    monkeypatch.setattr(ingest, "extract_pdf_pages_local", lambda path: _strong_local_pages())

    def fake_cloud(path, tier, trace_id):
        raise RuntimeError("cloud service down")

    monkeypatch.setattr(ingest, "extract_text_cloud", fake_cloud)

    result = ingest.extract_pdf_documents(
        path=Path("/tmp/sample.pdf"),
        requested_lane="default",
        tier="agentic",
        trace_id="trace-1",
        base_metadata={"filename": "sample.pdf"},
        parse_lane_policy="cloud_default",
    )

    assert result.parse_lane == "local_pypdf"
    assert result.parse_diagnostics["decision"] == "default_cloud_default_local_fallback"
    assert result.parse_diagnostics["fallback_reasons"] == ["cloud_parse_failed"]
    assert result.parse_diagnostics["cloud"]["error"] == "cloud service down"
    assert result.parse_diagnostics["local"]["trustworthy"] is True


def test_extract_pdf_documents_auto_fails_when_local_is_untrustworthy_and_cloud_unavailable(monkeypatch) -> None:
    monkeypatch.setattr(ingest.settings, "llama_cloud_api_key", None)
    monkeypatch.setattr(ingest, "extract_pdf_pages_local", lambda path: _weak_local_pages())
    monkeypatch.setattr(ingest, "extract_pdf_pages_ocr_local", lambda path: (_ for _ in ()).throw(ValueError("ocr unavailable")))

    with pytest.raises(ValueError, match="cloud fallback is unavailable"):
        ingest.extract_pdf_documents(
            path=Path("/tmp/sample.pdf"),
            requested_lane="default",
            tier="agentic",
            trace_id="trace-1",
            base_metadata={"filename": "sample.pdf"},
            parse_lane_policy="auto",
        )


def test_extract_pdf_documents_auto_uses_local_ocr_when_local_is_untrustworthy_and_cloud_is_unavailable(monkeypatch) -> None:
    monkeypatch.setattr(ingest.settings, "llama_cloud_api_key", None)
    monkeypatch.setattr(ingest, "_local_ocr_available", lambda: True)
    monkeypatch.setattr(ingest, "extract_pdf_pages_local", lambda path: _weak_local_pages())
    monkeypatch.setattr(ingest, "extract_pdf_pages_ocr_local", lambda path: _strong_local_pages())

    result = ingest.extract_pdf_documents(
        path=Path("/tmp/sample.pdf"),
        requested_lane="default",
        tier="agentic",
        trace_id="trace-1",
        base_metadata={"filename": "sample.pdf"},
        parse_lane_policy="auto",
    )

    assert result.parse_lane == "local_ocr"
    assert result.parse_diagnostics["decision"] == "default_auto_local_ocr_fallback"
    assert result.parse_diagnostics["local"]["trustworthy"] is False
    assert result.parse_diagnostics["ocr"]["trustworthy"] is True
    assert result.parse_diagnostics["selected_parse_lane"] == "local_ocr"


def test_extract_pdf_documents_local_requested_can_use_local_ocr(monkeypatch) -> None:
    monkeypatch.setattr(ingest.settings, "llama_cloud_api_key", None)
    monkeypatch.setattr(ingest, "_local_ocr_available", lambda: True)
    monkeypatch.setattr(ingest, "extract_pdf_pages_local", lambda path: _weak_local_pages())
    monkeypatch.setattr(ingest, "extract_pdf_pages_ocr_local", lambda path: _strong_local_pages())

    result = ingest.extract_pdf_documents(
        path=Path("/tmp/sample.pdf"),
        requested_lane="local",
        tier="agentic",
        trace_id="trace-1",
        base_metadata={"filename": "sample.pdf"},
        parse_lane_policy="auto",
    )

    assert result.parse_lane == "local_ocr"
    assert result.parse_diagnostics["decision"] == "local_only"
    assert result.parse_diagnostics["ocr"]["trustworthy"] is True


def test_build_pdf_document_metadata_includes_parse_diagnostics() -> None:
    metadata = workflows.build_pdf_document_metadata(
        artifact_count=4,
        pdf_extraction=SimpleNamespace(
            page_count=2,
            total_text_chars=420,
            parse_diagnostics={"decision": "default_auto_cloud_fallback", "selected_parse_lane": "llamaparse"},
        ),
        pdf_config=SimpleNamespace(
            chunk_size=900,
            chunk_overlap=120,
            sentence_window=2,
            parse_lane_policy="auto",
        ),
    )

    assert metadata["artifact_count"] == 4
    assert metadata["pdf_parse_diagnostics"]["decision"] == "default_auto_cloud_fallback"
    assert metadata["pdf_parse_diagnostics"]["selected_parse_lane"] == "llamaparse"
