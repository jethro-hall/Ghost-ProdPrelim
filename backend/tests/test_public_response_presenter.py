from __future__ import annotations

from ghostdash_api.public_response_presenter import (
    PUBLIC_FALLBACK_TEXT,
    PublicStreamPresenter,
    contains_forbidden_public_output,
    is_production_chat_surface,
    present_public_chat_response_payload,
    present_public_text,
)


def test_production_surface_detection_is_explicit() -> None:
    assert is_production_chat_surface("prod_chatui") is True
    assert is_production_chat_surface("ghost_chatui") is False
    assert is_production_chat_surface(None) is False


def test_forbidden_patterns_detect_public_leaks() -> None:
    for text in [
        "Odoo blocked legacy_odoo_public_surface_retired",
        "Regarding your question about the Odoo tool, it was blocked and did not execute.",
        "agent.orchestrator failed",
        "Scorecard and Citations",
        "Execution Truth: Source mode semantic",
        "backend error with trace_id",
        "raw payload",
        "provided documents and grounded information from the database",
    ]:
        assert contains_forbidden_public_output(text)


def test_present_public_text_replaces_unsafe_output() -> None:
    text, safe = present_public_text("agent.orchestrator failed with backend error")

    assert text == PUBLIC_FALLBACK_TEXT
    assert safe is False


def test_present_public_text_rewrites_raw_odoo_tool_failure() -> None:
    text, safe = present_public_text("Odoo was blocked and did not execute.")

    assert text == PUBLIC_FALLBACK_TEXT
    assert safe is False


def test_public_chat_response_strips_diagnostics_and_odoo_finance_card() -> None:
    payload = {
        "answer": "Here is the safe executive summary.",
        "query_mode": "semantic",
        "citations": [{"title": "Internal source"}],
        "conversation_mode": "board",
        "workflow_mode": "standard",
        "conversation_id": "conv-1",
        "agent_id": "agent-1",
        "cached": False,
        "usage": {"prompt_tokens": 1},
        "effective_snapshot_id": "snap-1",
        "tool_summary": [{"id": "odoo_primary"}],
        "route_decision": {"trace_id": "trace-1"},
        "tool_events": [
            {
                "tool_id": "odoo_primary",
                "status": "executed",
                "operation": "odoo.finance.roas",
                "summary": "Calculated finance card.",
                "blocked_reason": None,
                "payload": {
                    "response": {
                        "chat_summary_card": {"status": "ok", "period": "2026-03"},
                        "apryse_report_document": {"run_id": "run-1", "report_url": "/docx-artifacts/run-1.pdf"},
                        "raw_payload": {"secret": "debug"},
                    }
                },
                "latency_ms": 123,
            }
        ],
    }

    public = present_public_chat_response_payload(payload)

    assert public["citations"] == []
    assert public["usage"] is None
    assert public["route_decision"] is None
    assert public["effective_snapshot_id"] is None
    assert public["tool_summary"] == []
    assert public["tool_events"] == []


def test_public_chat_response_drops_unsafe_allowlisted_finance_payload() -> None:
    payload = {
        "answer": "Safe text",
        "tool_events": [
            {
                "tool_id": "odoo_primary",
                "status": "executed",
                "summary": "Calculated card.",
                "payload": {
                    "response": {
                        "chat_summary_card": {"status": "ok", "trace_id": "secret"},
                        "apryse_report_document": {"report_url": "/docx-artifacts/report.pdf", "raw_payload": {}},
                    }
                },
            }
        ],
    }

    public = present_public_chat_response_payload(payload)

    assert public["tool_events"] == []


def test_public_stream_presenter_strips_start_done_and_blocks_bad_delta() -> None:
    presenter = PublicStreamPresenter(enabled=True)

    start = presenter.present_event(
        {
            "type": "start",
            "api_mode": "responses",
            "conversation_mode": "quick",
            "citations": [{"title": "Internal"}],
            "route_decision": {"trace_id": "trace-1"},
            "effective_snapshot_id": "snap-1",
            "tool_summary": [{"id": "odoo_primary"}],
        }
    )
    assert start is not None
    assert start["citations"] == []
    assert "route_decision" not in start
    assert "effective_snapshot_id" not in start

    bad_delta = presenter.present_event({"type": "delta", "delta": "agent.orchestrator failed"})
    assert bad_delta == {"type": "delta", "delta": PUBLIC_FALLBACK_TEXT}
    assert presenter.present_event({"type": "delta", "delta": " more unsafe text"}) is None

    done = presenter.present_event(
        {
            "type": "done",
            "citations": [{"title": "Internal"}],
            "usage": {"prompt_tokens": 1},
            "llm_io": {"input_first_text": "prompt"},
            "route_decision": {"trace_id": "trace-1"},
            "tool_events": [],
        }
    )
    assert done is not None
    assert done["citations"] == []
    assert "usage" not in done
    assert "llm_io" not in done
    assert "route_decision" not in done


def test_public_stream_presenter_holds_back_split_forbidden_delta() -> None:
    presenter = PublicStreamPresenter(enabled=True)

    assert presenter.present_event({"type": "delta", "delta": "agent."}) is None
    second = presenter.present_event({"type": "delta", "delta": "orchestrator failed"})

    assert second == {"type": "delta", "delta": PUBLIC_FALLBACK_TEXT}
    assert presenter.present_event({"type": "delta", "delta": " with trace_id"}) is None


def test_public_stream_presenter_flushes_safe_holdback_on_done() -> None:
    presenter = PublicStreamPresenter(enabled=True)

    assert presenter.present_event({"type": "delta", "delta": "Short safe answer."}) is None
    done = presenter.present_event({"type": "done", "tool_events": []})

    assert isinstance(done, list)
    assert done[0] == {"type": "delta", "delta": "Short safe answer."}
    assert done[1]["type"] == "done"
