from __future__ import annotations

import json

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from ghostdash_api import agent_ingress, tool_registry
from ghostdash_api.database import Base, get_session
from ghostdash_api.models import (
    AgentMessageRecord,
    AgentProfileRecord,
    ChatResponseCacheRecord,
    ConnectionRecord,
    RuntimeProfileRecord,
)
from ghostdash_api.runtime_profiles import seed_default_runtime_profile
from ghostdash_api.schemas import ToolExecuteResponse, ToolReadinessSummary


def build_client(monkeypatch):
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)

    monkeypatch.setattr(agent_ingress, "initialize_agent_runtime_state", lambda: None)
    monkeypatch.setattr(agent_ingress, "seed_default_agent_profiles", lambda session: None)
    monkeypatch.setattr(
        agent_ingress,
        "resolve_llm_connection",
        lambda session, **kwargs: ConnectionRecord(
            provider="openai",
            label="OpenAI",
            provider_kind="openai",
            auth_strategy="bearer",
            auth_header_name=None,
            api_key="test-key",
            base_url="https://api.openai.com/v1",
            enabled=True,
        ),
    )
    monkeypatch.setattr(agent_ingress, "SessionLocal", SessionLocal)

    def override_get_session():
        with SessionLocal() as session:
            yield session

    app = agent_ingress.create_app()
    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app), SessionLocal


def seed_agent(SessionLocal) -> str:
    with SessionLocal() as session:
        runtime_profile = seed_default_runtime_profile(session)
        agent = AgentProfileRecord(
            name="Hotfix Agent",
            first_message="hello",
            language="en-US",
            voice_id="alloy",
            runtime_profile_id=runtime_profile.id,
            is_default=True,
            enabled=True,
        )
        session.add(agent)
        session.commit()
        return agent.id


def configured_agent_max_tokens(SessionLocal, *, agent_id: str) -> int:
    with SessionLocal() as session:
        agent = session.get(AgentProfileRecord, agent_id)
        assert agent is not None
        profile = session.get(RuntimeProfileRecord, agent.runtime_profile_id)
        assert profile is not None
        return int((profile.llm_config_json or {}).get("max_tokens", 2000))


def build_long_query_prompt(question: str) -> str:
    grounded_context = "\n".join(
        f"[{index}] grounded excerpt {'context ' * 20}{'evidence ' * 18}"
        for index in range(80)
    )
    return (
        "Use only the grounded context below. If the question asks for an exact row value, prefer the structured lookup evidence first.\n\n"
        f"Semantic retrieval candidates:\n{grounded_context}\n\n"
        f"User question: {question}"
    )


def parse_sse_events(body: str) -> list[dict]:
    events: list[dict] = []
    for block in body.strip().split("\n\n"):
        if not block.strip():
            continue
        assert block.startswith("data: ")
        events.append(json.loads(block.removeprefix("data: ")))
    return events


def build_plan(question: str) -> dict:
    return {
        "query_mode": "semantic",
        "direct_answer": None,
        "prompt": build_long_query_prompt(question),
        "citations": [
            {
                "document_id": "doc-1",
                "filename": "brief.txt",
                "corpus": "default",
                "artifact_type": "chunk",
                "source_path": "/tmp/brief.txt",
            }
        ],
    }


def test_prepare_answer_prompt_drops_history_before_query_and_preserves_question() -> None:
    question = "Why did the browser stream fail?"
    history_context = "\n".join(
        f"User: old history {index} {'history ' * 24}"
        for index in range(48)
    )

    package = agent_ingress.prepare_answer_prompt(
        agent_name="Hotfix Agent",
        system_prompt="System prompt is passed separately.",
        query_prompt=build_long_query_prompt(question),
        history_context=history_context,
        runtime_context="Runtime profile: test\nActive corpora: default",
        approved_web_context="",
        upload_context="",
        budget=agent_ingress.RETRY_ANSWER_PROMPT_BUDGET,
    )

    assert package.compacted is True
    assert package.total_chars <= agent_ingress.RETRY_ANSWER_PROMPT_BUDGET.max_total_chars
    assert package.prompt.endswith(f"User question: {question}")
    assert "old history 0" not in package.prompt
    assert "Semantic retrieval candidates:" in package.prompt
    assert "history" in package.trimmed_sections
    assert "query_prompt" in package.trimmed_sections


def test_chat_completions_budgets_are_tighter_and_retry_drops_history() -> None:
    question = "Build a grounded executive summary for the live stream failure."
    history_context = "\n".join(
        f"User: prior turn {index} {'history ' * 24}"
        for index in range(48)
    )

    responses_primary, responses_retry = agent_ingress.prepare_answer_prompt_variants(
        api_mode="responses",
        agent_name="Hotfix Agent",
        system_prompt="System prompt is passed separately.",
        query_prompt=build_long_query_prompt(question),
        history_context=history_context,
        runtime_context="Runtime profile: test\nActive corpora: default",
        approved_web_context="Approved source evidence " * 80,
        upload_context="Upload context " * 120,
    )
    chat_primary, chat_retry = agent_ingress.prepare_answer_prompt_variants(
        api_mode="chat_completions",
        agent_name="Hotfix Agent",
        system_prompt="System prompt is passed separately.",
        query_prompt=build_long_query_prompt(question),
        history_context=history_context,
        runtime_context="Runtime profile: test\nActive corpora: default",
        approved_web_context="Approved source evidence " * 80,
        upload_context="Upload context " * 120,
    )

    assert chat_primary.total_chars < responses_primary.total_chars
    assert chat_retry.total_chars < responses_retry.total_chars
    assert chat_retry.total_chars <= chat_primary.total_chars - 1200
    assert chat_retry.history_chars == 0
    assert chat_primary.prompt.endswith(f"User question: {question}")
    assert chat_retry.prompt.endswith(f"User question: {question}")


def test_agent_chat_uses_compacted_prompt_for_sync_route(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)
    question = "What is breaking the browser stream?"
    captured_prompts: list[str] = []
    captured_max_tokens: list[int] = []

    async def fake_fetch_query_plan(*args, **kwargs) -> dict:
        return build_plan(question)

    monkeypatch.setattr(agent_ingress, "fetch_query_plan", fake_fetch_query_plan)

    def fake_generate_answer(prompt, *_args, **kwargs):
        captured_prompts.append(prompt)
        captured_max_tokens.append(kwargs["max_tokens"])
        return "sync ok"

    monkeypatch.setattr(agent_ingress, "generate_answer", fake_generate_answer)

    response = client.post("/agent/chat", json={"message": question, "agent_id": agent_id, "api_mode": "chat_completions"})

    assert response.status_code == 200
    assert response.json()["answer"] == "sync ok"
    assert len(captured_prompts) == 1
    assert len(captured_prompts[0]) <= agent_ingress.CHAT_COMPLETIONS_PRIMARY_ANSWER_PROMPT_BUDGET.max_total_chars
    expected = agent_ingress.resolve_answer_max_tokens(
        api_mode="chat_completions",
        configured_max_tokens=configured_agent_max_tokens(SessionLocal, agent_id=agent_id),
        prompt=captured_prompts[0],
        trace_id="test",
        openai_responses_chain=False,
    )
    assert captured_max_tokens == [expected]
    assert captured_prompts[0].endswith(f"User question: {question}")


def test_agent_chat_stream_retries_with_more_compact_prompt_before_first_delta(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)
    question = "Why did the live browser chat fail?"
    attempt_prompts: list[str] = []
    attempt_max_tokens: list[int] = []

    class FakeLengthError(Exception):
        pass

    async def fake_fetch_query_plan(*args, **kwargs) -> dict:
        return build_plan(question)

    def fake_stream_answer(prompt, *_args, **_kwargs):
        attempt_prompts.append(prompt)
        attempt_max_tokens.append(_kwargs["max_tokens"])
        if len(attempt_prompts) == 1:
            raise FakeLengthError("guardrail: input exceeds max length")
        yield "Recovered answer"

    monkeypatch.setattr(agent_ingress, "fetch_query_plan", fake_fetch_query_plan)
    monkeypatch.setattr(agent_ingress, "stream_answer", fake_stream_answer)

    response = client.post(
        "/agent/chat/stream",
        json={"message": question, "agent_id": agent_id, "api_mode": "chat_completions"},
    )
    events = parse_sse_events(response.text)

    assert response.status_code == 200
    assert [event["type"] for event in events] == ["start", "delta", "done"]
    assert events[1]["delta"] == "Recovered answer"
    assert len(attempt_prompts) == 2
    assert len(attempt_prompts[1]) <= len(attempt_prompts[0]) - 1200
    expected = agent_ingress.resolve_answer_max_tokens(
        api_mode="chat_completions",
        configured_max_tokens=configured_agent_max_tokens(SessionLocal, agent_id=agent_id),
        prompt=attempt_prompts[0],
        trace_id="test",
        openai_responses_chain=False,
    )
    assert attempt_max_tokens == [expected, expected]

    with SessionLocal() as session:
        assistant_messages = list(
            session.scalars(select(AgentMessageRecord).where(AgentMessageRecord.role == "assistant"))
        )

    assert assistant_messages[-1].content == "Recovered answer"


def test_agent_chat_stream_emits_length_fallback_and_done_when_retry_still_fails(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)
    question = "Why did the live browser chat fail?"
    attempt_prompts: list[str] = []
    attempt_max_tokens: list[int] = []

    class FakeLengthError(Exception):
        pass

    async def fake_fetch_query_plan(*args, **kwargs) -> dict:
        return build_plan(question)

    def fake_stream_answer(prompt, *_args, **_kwargs):
        attempt_prompts.append(prompt)
        attempt_max_tokens.append(_kwargs["max_tokens"])
        raise FakeLengthError("guardrail: input exceeds max length")

    monkeypatch.setattr(agent_ingress, "fetch_query_plan", fake_fetch_query_plan)
    monkeypatch.setattr(agent_ingress, "stream_answer", fake_stream_answer)

    response = client.post(
        "/agent/chat/stream",
        json={"message": question, "agent_id": agent_id, "api_mode": "chat_completions"},
    )
    events = parse_sse_events(response.text)

    assert response.status_code == 200
    assert events[0]["type"] == "start"
    assert events[-1]["type"] == "done"
    assert "upstream model rejected the prompt length" in events[1]["delta"]
    assert len(attempt_prompts) == 2
    assert len(attempt_prompts[1]) <= len(attempt_prompts[0]) - 1200
    expected = agent_ingress.resolve_answer_max_tokens(
        api_mode="chat_completions",
        configured_max_tokens=configured_agent_max_tokens(SessionLocal, agent_id=agent_id),
        prompt=attempt_prompts[0],
        trace_id="test",
        openai_responses_chain=False,
    )
    assert attempt_max_tokens == [expected, expected]

    with SessionLocal() as session:
        assistant_messages = list(
            session.scalars(select(AgentMessageRecord).where(AgentMessageRecord.role == "assistant"))
        )
        cache_rows = list(session.scalars(select(ChatResponseCacheRecord)))

    assert assistant_messages[-1].content == events[1]["delta"]
    assert cache_rows == []


def test_agent_chat_stream_start_includes_tool_summary_and_effective_snapshot_id(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)

    async def fake_fetch_query_plan(*args, **kwargs) -> dict:
        return {
            "query_mode": "semantic",
            "direct_answer": "Tool summary ready",
            "prompt": "User question: Tool summary ready",
            "citations": [],
        }

    monkeypatch.setattr(agent_ingress, "fetch_query_plan", fake_fetch_query_plan)

    with SessionLocal() as session:
        record = tool_registry.get_or_create_odoo_registry(session)
        record.active = True
        record.status = "healthy"
        record.config_json = {
            "base_url": "https://odoo.example.com",
            "database": "ghost",
            "username": "operator@example.com",
            "password": "super-secret",
            "auth_source": "direct_credentials",
            "read_only": True,
            "timeout_ms": 20000,
            "health_path": "/api/tools/odoo_primary/test",
            "execute_path": "/api/tools/odoo_primary/execute",
        }
        session.add(record)
        session.commit()
        tool_registry.update_agent_tool_policy(session, agent_id, ["odoo_primary"])

    response = client.post(
        "/agent/chat/stream",
        json={
            "message": "Can you use Odoo?",
            "agent_id": agent_id,
            "api_mode": "responses",
            "tool_overrides": {"odoo_primary": False},
        },
    )
    events = parse_sse_events(response.text)

    assert response.status_code == 200
    assert events[0]["type"] == "start"
    assert events[0]["effective_snapshot_id"]
    assert events[0]["tool_summary"][0]["id"] == "odoo_primary"
    assert events[0]["tool_summary"][0]["status"] == "disabled_for_session"
    assert "Turned off for this session" in events[0]["tool_summary"][0]["blocked_reasons"]
    assert events[0]["tool_summary"][0]["enabled_for_agent"] is True
    assert events[0]["tool_summary"][0]["health"] == "healthy"


def test_agent_chat_returns_preview_tool_event_for_operation_only_requests(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)

    async def fake_fetch_query_plan(*args, **kwargs) -> dict:
        return {
            "query_mode": "semantic",
            "direct_answer": "odoo.rpc.search_read\n\n```json\n{\"operation\":\"odoo.rpc.search_read\"}\n```",
            "prompt": None,
            "citations": [],
            "tool_plan": {
                "tool_id": "odoo_primary",
                "mode": "preview",
                "operation": "odoo.rpc.search_read",
                "payload": {"model": "res.company", "fields": ["id", "name"]},
                "reason": "Preview only",
            },
        }

    monkeypatch.setattr(agent_ingress, "fetch_query_plan", fake_fetch_query_plan)

    response = client.post(
        "/agent/chat",
        json={"message": "Do not execute Odoo; show the exact operation and payload.", "agent_id": agent_id},
    )

    assert response.status_code == 200
    body = response.json()
    assert "odoo.rpc.search_read" in body["answer"]
    assert body["tool_events"][0]["status"] == "preview"
    assert body["tool_events"][0]["operation"] == "odoo.rpc.search_read"
    assert body["cached"] is False


def test_agent_chat_stream_emits_tool_result_before_answer(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)

    async def fake_fetch_query_plan(*args, **kwargs) -> dict:
        return {
            "query_mode": "semantic",
            "direct_answer": None,
            "prompt": "User question: what are open receivables?",
            "citations": [],
            "tool_plan": {
                "tool_id": "odoo_primary",
                "mode": "required",
                "operation": "odoo.finance.receivables.open",
                "payload": {"limit": 5},
                "reason": "Need live AR evidence.",
            },
        }

    def fake_execute_tool_operation_for_agent(*_args, **_kwargs):
        return (
            ToolExecuteResponse(
                success=True,
                message="ok",
                operation="odoo.finance.receivables.open",
                latency_ms=12,
                data={"count": 2, "records": [{"id": 1}, {"id": 2}], "total_residual": 1200},
            ),
            ToolReadinessSummary(
                id="odoo_primary",
                status="ready",
                blocked_reasons=[],
                active=True,
                enabled_for_agent=True,
                session_enabled=True,
                health="healthy",
            ),
        )

    def fake_stream_answer(prompt, *_args, **_kwargs):
        assert "Tool evidence:" in prompt
        yield "Tool-backed answer"

    monkeypatch.setattr(agent_ingress, "fetch_query_plan", fake_fetch_query_plan)
    monkeypatch.setattr(agent_ingress, "execute_tool_operation_for_agent", fake_execute_tool_operation_for_agent)
    monkeypatch.setattr(agent_ingress, "stream_answer", fake_stream_answer)

    response = client.post(
        "/agent/chat/stream",
        json={"message": "What are open receivables?", "agent_id": agent_id, "api_mode": "responses"},
    )
    events = parse_sse_events(response.text)

    assert response.status_code == 200
    assert [event["type"] for event in events] == ["start", "tool_result", "delta", "done"]
    assert events[1]["tool_event"]["status"] == "executed"
    assert events[1]["tool_event"]["operation"] == "odoo.finance.receivables.open"
    assert events[2]["delta"] == "Tool-backed answer"
    assert events[3]["tool_events"][0]["status"] == "executed"


def test_agent_chat_falls_back_when_monthly_margin_helper_is_unavailable(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)
    captured_prompts: list[str] = []

    async def fake_fetch_query_plan(*args, **kwargs) -> dict:
        return {
            "query_mode": "semantic",
            "direct_answer": None,
            "prompt": "User question: compare GP across companies 3, 4, and 5 for the last 4 completed months",
            "citations": [],
            "tool_plan": {
                "tool_id": "odoo_primary",
                "mode": "required",
                "operation": "odoo.finance.margin.monthly_comparison",
                "payload": {"company_ids": [3, 4, 5], "months": 4, "include_current_month": False},
                "reason": "Need monthly GP comparison.",
            },
        }

    def fake_execute_tool_operation_for_agent(*_args, **kwargs):
        operation = kwargs["operation"]
        if operation == "odoo.finance.margin.monthly_comparison":
            return (
                ToolExecuteResponse(
                    success=False,
                    message="Unsupported Odoo operation: odoo.finance.margin.monthly_comparison",
                    operation=operation,
                    data={},
                ),
                ToolReadinessSummary(
                    id="odoo_primary",
                    status="ready",
                    blocked_reasons=[],
                    active=True,
                    enabled_for_agent=True,
                    session_enabled=True,
                    health="healthy",
                ),
            )
        if operation == "odoo.finance.revenue.monthly":
            return (
                ToolExecuteResponse(
                    success=True,
                    message="ok",
                    operation=operation,
                    latency_ms=8,
                    data={
                        "date_from": "2026-01-01",
                        "date_to": "2026-03-01",
                        "months": 2,
                        "company_name_by_id": {"3": "Ride Electric Retail"},
                        "rows": [
                            {"company_id": [3, "Ride Electric Retail"], "invoice_date:month": "2026-01", "amount_untaxed_signed": 1500.0},
                            {"company_id": [3, "Ride Electric Retail"], "invoice_date:month": "2026-02", "amount_untaxed_signed": 1800.0},
                        ],
                    },
                ),
                ToolReadinessSummary(
                    id="odoo_primary",
                    status="ready",
                    blocked_reasons=[],
                    active=True,
                    enabled_for_agent=True,
                    session_enabled=True,
                    health="healthy",
                ),
            )
        if operation == "odoo.finance.cogs.monthly":
            return (
                ToolExecuteResponse(
                    success=True,
                    message="ok",
                    operation=operation,
                    latency_ms=7,
                    data={
                        "date_from": "2026-01-01",
                        "date_to": "2026-03-01",
                        "months": 2,
                        "company_name_by_id": {"3": "Ride Electric Retail"},
                        "rows": [
                            {"company_id": [3, "Ride Electric Retail"], "date:month": "2026-01", "balance": 700.0},
                            {"company_id": [3, "Ride Electric Retail"], "date:month": "2026-02", "balance": 1000.0},
                        ],
                    },
                ),
                ToolReadinessSummary(
                    id="odoo_primary",
                    status="ready",
                    blocked_reasons=[],
                    active=True,
                    enabled_for_agent=True,
                    session_enabled=True,
                    health="healthy",
                ),
            )
        raise AssertionError(f"Unexpected operation {operation}")

    def fake_generate_answer(prompt, *_args, **_kwargs):
        captured_prompts.append(prompt)
        return "fallback ok"

    monkeypatch.setattr(agent_ingress, "fetch_query_plan", fake_fetch_query_plan)
    monkeypatch.setattr(agent_ingress, "execute_tool_operation_for_agent", fake_execute_tool_operation_for_agent)
    monkeypatch.setattr(agent_ingress, "generate_answer", fake_generate_answer)

    response = client.post(
        "/agent/chat",
        json={"message": "Compare GP across companies 3, 4, and 5 for the last 4 completed months.", "agent_id": agent_id},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["answer"] == "fallback ok"
    assert body["tool_events"][0]["status"] == "executed"
    assert body["tool_events"][0]["operation"] == "odoo.finance.margin.monthly_comparison"
    assert "fallback" in body["tool_events"][0]["summary"].lower()
    assert captured_prompts
    assert "Named helper fallback used" in captured_prompts[0]
    assert "Executed Odoo monthly margin comparison:" in captured_prompts[0]
