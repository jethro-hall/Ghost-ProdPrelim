from __future__ import annotations

from sqlalchemy import select

from ghostdash_api.models import AgentMessageRecord, AgentProfileRecord, RuntimeProfileRecord
from ghostdash_api.public_response_presenter import PUBLIC_FALLBACK_TEXT
from ghostdash_api.magic_mike import MAGIC_MIKE_AGENT_NAME, magic_mike_runtime_profile_payload

from test_agent_ingress_prompt_hotfix import build_client, build_plan, parse_sse_events, seed_agent


def test_prod_chatui_stream_blocks_forbidden_output_without_breaking_diagnostic_persistence(monkeypatch) -> None:
    from ghostdash_api import agent_ingress

    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_magic_mike(SessionLocal)

    async def fake_fetch_query_plan(*args, **kwargs) -> dict:
        return build_plan("Show bad output")

    def fake_stream_answer(*_args, **_kwargs):
        yield "agent.orchestrator failed with backend error and trace_id"

    monkeypatch.setattr(agent_ingress, "fetch_query_plan", fake_fetch_query_plan)
    monkeypatch.setattr(agent_ingress, "stream_answer", fake_stream_answer)

    response = client.post(
        "/agent/chat/stream",
        json={
            "message": "Show bad output",
            "agent_id": agent_id,
            "api_mode": "responses",
            "surface": "prod_chatui",
                "route_mode": "production_chat",
                "agent_category": "consumer_customer",
                "public_presenter_required": True,
                "retail_output_guard_required": True,
                "diagnostics_visible": False,
        },
    )

    events = parse_sse_events(response.text)
    public_text = "".join(event.get("delta", "") for event in events if event["type"] == "delta")

    assert response.status_code == 200
    assert public_text == PUBLIC_FALLBACK_TEXT
    assert "agent.orchestrator" not in response.text
    assert "backend error" not in response.text
    assert "trace_id" not in response.text
    assert events[0]["citations"] == []
    assert "route_decision" not in events[0]
    assert "effective_snapshot_id" not in events[0]
    assert events[-1]["citations"] == []
    assert "route_decision" not in events[-1]
    assert "llm_io" not in events[-1]

    with SessionLocal() as session:
        assistant = session.scalar(select(AgentMessageRecord).where(AgentMessageRecord.role == "assistant"))

    assert assistant is not None
    assert "agent.orchestrator failed" in assistant.content
    assert assistant.citations_json


def test_ghost_chatui_stream_keeps_existing_diagnostic_payloads(monkeypatch) -> None:
    from ghostdash_api import agent_ingress

    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)

    async def fake_fetch_query_plan(*args, **kwargs) -> dict:
        return build_plan("Keep debug output")

    def fake_stream_answer(*_args, **_kwargs):
        yield "agent.orchestrator failed with backend error and trace_id"

    monkeypatch.setattr(agent_ingress, "fetch_query_plan", fake_fetch_query_plan)
    monkeypatch.setattr(agent_ingress, "stream_answer", fake_stream_answer)

    response = client.post(
        "/agent/chat/stream",
        json={"message": "Keep debug output", "agent_id": agent_id, "api_mode": "responses"},
    )

    events = parse_sse_events(response.text)
    debug_text = "".join(event.get("delta", "") for event in events if event["type"] == "delta")

    assert response.status_code == 200
    assert "agent.orchestrator failed" in debug_text
    assert events[0]["citations"]
    assert "route_decision" in events[0]
    assert "route_decision" in events[-1]


def seed_magic_mike(SessionLocal) -> str:
    payload = magic_mike_runtime_profile_payload()
    with SessionLocal() as session:
        runtime_profile = RuntimeProfileRecord(**payload)
        session.add(runtime_profile)
        session.flush()
        agent = AgentProfileRecord(
            name=MAGIC_MIKE_AGENT_NAME,
            first_message="Hi, you're speaking with Magic Mike at Ride Electric. How can I help?",
            language="en-AU",
            voice_id="alloy",
            runtime_profile_id=runtime_profile.id,
            is_default=False,
            enabled=True,
        )
        session.add(agent)
        session.commit()
        return agent.id


def test_prod_magic_mike_greeting_after_odoo_failure_bypasses_tools_and_history(monkeypatch) -> None:
    from ghostdash_api import agent_ingress
    from ghostdash_api.agent_memory import append_message, create_conversation

    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_magic_mike(SessionLocal)
    with SessionLocal() as session:
        conversation = create_conversation(
            session,
            agent_id=agent_id,
            message="Odoo blocked and did not execute.",
            corpora=["ride-electric-products"],
            api_mode="responses",
            conversation_mode="quick",
            workflow_mode="standard",
        )
        append_message(
            session,
            conversation_id=conversation.id,
            agent_id=agent_id,
            role="assistant",
            content="Regarding your question about the Odoo tool, it was blocked and did not execute.",
            citations=[],
            conversation_mode="quick",
            workflow_mode="standard",
        )
        session.commit()
        conversation_id = conversation.id

    async def forbidden_fetch_query_plan(*args, **kwargs) -> dict:
        raise AssertionError("greeting should not call planner or tools")

    monkeypatch.setattr(agent_ingress, "fetch_query_plan", forbidden_fetch_query_plan)

    second = client.post(
        "/agent/chat/stream",
        json={
            "message": "Hi Magic, how's it going?",
            "agent_id": agent_id,
            "conversation_id": conversation_id,
            "api_mode": "responses",
            "surface": "prod_chatui",
            "route_mode": "production_chat",
            "agent_category": "consumer_customer",
            "public_presenter_required": True,
            "retail_output_guard_required": True,
            "diagnostics_visible": False,
        },
    )

    events = parse_sse_events(second.text)
    public_text = "".join(event.get("delta", "") for event in events if event["type"] == "delta")

    assert second.status_code == 200
    assert public_text == "I’m good, thanks. What can I help you sort out with Ride Electric?"
    assert "Odoo" not in public_text
    assert "tool" not in public_text
    assert "blocked" not in public_text


def test_prod_chatui_rejects_non_magic_mike_agent(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)

    response = client.post(
        "/agent/chat/stream",
        json={
            "message": "Hi",
            "agent_id": agent_id,
            "api_mode": "responses",
            "surface": "prod_chatui",
            "route_mode": "production_chat",
            "agent_category": "consumer_customer",
            "public_presenter_required": True,
            "retail_output_guard_required": True,
            "diagnostics_visible": False,
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Magic Mike is not available in the correct customer-service mode right now."


def test_magic_mike_tool_policy_excludes_odoo() -> None:
    payload = magic_mike_runtime_profile_payload()
    tools = payload["tool_policy_config_json"]["tools"]

    tool_ids = {tool["id"] for tool in tools if tool.get("enabled")}

    assert "odoo_primary" not in tool_ids
    assert {"kb", "web"}.issubset(tool_ids)
