"""Tests for Odoo multi-step tool loop gating and helpers."""

from __future__ import annotations

from unittest.mock import MagicMock

from ghostdash_api.odoo_agentic import (
    connection_supports_odoo_agentic_tool_loop,
    external_citations_for_tool_events,
    should_use_odoo_agentic,
)
from ghostdash_api.schemas import ChatRequest, ChatToolEvent


def _conn(*, provider_kind: str = "openai", base_url: str = "https://api.openai.com/v1") -> MagicMock:
    c = MagicMock()
    c.provider = "openai"
    c.label = "test"
    c.api_key = "sk-test"
    c.base_url = base_url
    c.provider_kind = provider_kind
    c.auth_strategy = "bearer"
    c.auth_header_name = None
    return c


def test_should_use_odoo_agentic_requires_specialist_and_odoo_ready() -> None:
    body = ChatRequest(message="x", odoo_agentic=None)
    conn = _conn()
    assert (
        should_use_odoo_agentic(
            body=body,
            workflow_mode="standard",
            odoo_ready=True,
            connection=conn,
            use_openai_responses_chain=False,
        )
        is False
    )
    assert (
        should_use_odoo_agentic(
            body=body,
            workflow_mode="odoo_specialist",
            odoo_ready=False,
            connection=conn,
            use_openai_responses_chain=False,
        )
        is False
    )


def test_should_use_odoo_agentic_respects_explicit_false() -> None:
    body = ChatRequest(message="x", odoo_agentic=False)
    conn = _conn()
    assert (
        should_use_odoo_agentic(
            body=body,
            workflow_mode="odoo_specialist",
            odoo_ready=True,
            connection=conn,
            use_openai_responses_chain=False,
        )
        is False
    )


def test_connection_supports_tool_loop_false_for_responses_chain() -> None:
    conn = _conn()
    assert connection_supports_odoo_agentic_tool_loop(conn, use_openai_responses_chain=True) is False
    assert connection_supports_odoo_agentic_tool_loop(conn, use_openai_responses_chain=False) is True


def test_external_citations_filters_non_odoo() -> None:
    events = [
        ChatToolEvent(tool_id="odoo_primary", status="executed", operation="odoo.x", summary="ok"),
        ChatToolEvent(tool_id="other", status="executed", operation="x", summary="ok"),
    ]
    cites = external_citations_for_tool_events(events)
    assert len(cites) == 1
    assert cites[0]["tool_id"] == "odoo_primary"
