from __future__ import annotations

from types import SimpleNamespace

from ghostdash_api.agent_memory import build_response_cache_key


def _agent() -> SimpleNamespace:
    return SimpleNamespace(id="agent-1", name="Odoo Specialist")


def _runtime_profile() -> SimpleNamespace:
    return SimpleNamespace(
        id="runtime-1",
        llm_config_json={"model_id": "gpt-5"},
        guardrails_config_json={"conversation_mode": "working_session"},
        kb_config_json={"corpora": ["odoo-context"]},
        retrieval_config_json={"top_k": 8},
        tool_policy_config_json={"enabled_tools": ["odoo_primary"]},
    )


def test_build_response_cache_key_isolated_by_conversation_id() -> None:
    common = {
        "agent": _agent(),
        "runtime_profile": _runtime_profile(),
        "history_context": "",
        "message": "Show revenue for this month.",
        "corpora": ["odoo-context"],
        "api_mode": "responses",
        "tool_state": {"tool_plan_mode": "none"},
    }

    key_one = build_response_cache_key(conversation_id="conv-a", **common)
    key_two = build_response_cache_key(conversation_id="conv-b", **common)

    assert key_one != key_two


def test_build_response_cache_key_stable_with_same_conversation_id() -> None:
    common = {
        "agent": _agent(),
        "runtime_profile": _runtime_profile(),
        "conversation_id": "conv-a",
        "history_context": "User: hi",
        "message": "Show top products by GP this quarter.",
        "corpora": ["odoo-context"],
        "api_mode": "responses",
        "tool_state": {"workflow_mode": "standard"},
    }

    assert build_response_cache_key(**common) == build_response_cache_key(**common)
