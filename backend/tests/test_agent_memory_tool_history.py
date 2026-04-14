from __future__ import annotations

from ghostdash_api.agent_memory import build_history_context
from ghostdash_api.models import AgentMessageRecord


def test_build_history_context_omits_tool_source_summary() -> None:
    messages = [
        AgentMessageRecord(
            conversation_id="conv-1",
            agent_id="agent-1",
            role="assistant",
            content="Revenue is up.",
            citations_json=[
                {
                    "source_type": "tool",
                    "title": "Odoo quarterly margin",
                    "operation": "odoo.finance.margin.quarterly_summary",
                    "tool_status": "executed",
                }
            ],
        )
    ]

    context = build_history_context(messages, window_messages=4)

    assert "Revenue is up." in context
    assert "Odoo quarterly margin" not in context
    assert "odoo.finance.margin.quarterly_summary" not in context
    assert "executed" not in context
