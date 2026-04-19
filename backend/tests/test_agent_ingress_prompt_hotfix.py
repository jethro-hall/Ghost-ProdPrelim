from __future__ import annotations

import json

from fastapi.testclient import TestClient
import pytest
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
from ghostdash_api.runtime import LlmCompletionResult
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


def test_execute_sub_agent_with_retries_retries_then_succeeds(monkeypatch) -> None:
    attempts = {"count": 0}

    def fake_run_sub_agent_completion(**_kwargs):
        attempts["count"] += 1
        if attempts["count"] < 2:
            raise RuntimeError("transient worker failure")
        return LlmCompletionResult(text="worker-ok", openai_response_id=None, usage=None)

    monkeypatch.setattr(agent_ingress, "_run_sub_agent_completion", fake_run_sub_agent_completion)
    monkeypatch.setattr(agent_ingress, "SUB_AGENT_MAX_RETRIES", 1)
    monkeypatch.setattr(agent_ingress, "SUB_AGENT_RETRY_BACKOFF_SECONDS", 0.01)

    worker = AgentProfileRecord(name="[SA] Finance Worker", first_message="x", language="en-US", voice_id="alloy")
    result, attempts_used = agent_ingress._execute_sub_agent_with_retries(
        session=None,
        worker=worker,
        user_message="Need financial brief",
        tool_grounding_prompt="Grounded facts",
        prior_worker_outputs=[],
        fallback_api_mode="responses",
        trace_id="test-trace",
    )

    assert result.text == "worker-ok"
    assert attempts_used == 2


def test_execute_sub_agent_with_retries_exhausts_budget(monkeypatch) -> None:
    attempts = {"count": 0}

    def fake_run_sub_agent_completion(**_kwargs):
        attempts["count"] += 1
        raise RuntimeError("persistent worker failure")

    monkeypatch.setattr(agent_ingress, "_run_sub_agent_completion", fake_run_sub_agent_completion)
    monkeypatch.setattr(agent_ingress, "SUB_AGENT_MAX_RETRIES", 1)
    monkeypatch.setattr(agent_ingress, "SUB_AGENT_RETRY_BACKOFF_SECONDS", 0.0)

    worker = AgentProfileRecord(name="[SA] Document Worker", first_message="x", language="en-US", voice_id="alloy")
    with pytest.raises(RuntimeError, match="persistent worker failure"):
        agent_ingress._execute_sub_agent_with_retries(
            session=None,
            worker=worker,
            user_message="Need board-ready document",
            tool_grounding_prompt="Grounded facts",
            prior_worker_outputs=[],
            fallback_api_mode="responses",
            trace_id="test-trace",
        )
    assert attempts["count"] == 2


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

    responses_primary, responses_retry, responses_tertiary = agent_ingress.prepare_answer_prompt_variants(
        api_mode="responses",
        agent_name="Hotfix Agent",
        system_prompt="System prompt is passed separately.",
        query_prompt=build_long_query_prompt(question),
        history_context=history_context,
        runtime_context="Runtime profile: test\nActive corpora: default",
        approved_web_context="Approved source evidence " * 80,
        upload_context="Upload context " * 120,
    )
    chat_primary, chat_retry, chat_tertiary = agent_ingress.prepare_answer_prompt_variants(
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
    assert chat_tertiary.total_chars <= chat_retry.total_chars
    assert responses_tertiary.total_chars <= responses_retry.total_chars
    assert chat_retry.history_chars == 0
    assert chat_tertiary.history_chars == 0
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
    assert len(attempt_prompts) == 3
    assert len(attempt_prompts[1]) <= len(attempt_prompts[0]) - 1200
    assert len(attempt_prompts[2]) <= len(attempt_prompts[1]) - 800
    expected = agent_ingress.resolve_answer_max_tokens(
        api_mode="chat_completions",
        configured_max_tokens=configured_agent_max_tokens(SessionLocal, agent_id=agent_id),
        prompt=attempt_prompts[0],
        trace_id="test",
        openai_responses_chain=False,
    )
    assert attempt_max_tokens == [expected, expected, expected]

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
    assert events[0]["route_decision"]["route_type"] == "direct"


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
    assert body["route_decision"]["route_type"] == "workers"
    assert body["cached"] is False

    with SessionLocal() as session:
        assistant = session.scalar(select(AgentMessageRecord).where(AgentMessageRecord.role == "assistant"))
        assert assistant is not None
        assert (assistant.route_decision_json or {}).get("route_type") == "workers"


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
    assert events[0]["type"] == "start"
    assert events[-1]["type"] == "done"
    tool_events = [event["tool_event"] for event in events if event["type"] == "tool_result"]
    assert any(event["status"] == "executed" and event["operation"] == "odoo.finance.receivables.open" for event in tool_events)
    delta_events = [event for event in events if event["type"] == "delta"]
    assert delta_events
    assert delta_events[-1]["delta"] == "Tool-backed answer"
    assert any(event["status"] == "executed" for event in events[-1]["tool_events"])

    with SessionLocal() as session:
        assistant_messages = list(
            session.scalars(select(AgentMessageRecord).where(AgentMessageRecord.role == "assistant"))
        )

    assert assistant_messages[-1].tool_events_json[0]["operation"] == "odoo.finance.receivables.open"
    assert assistant_messages[-1].usage_json is not None
    assert int(assistant_messages[-1].usage_json["total_tokens"]) >= 0


def test_agent_chat_persists_provider_usage_from_final_hop(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)

    async def fake_fetch_query_plan(*args, **kwargs) -> dict:
        return {
            "query_mode": "semantic",
            "direct_answer": None,
            "prompt": "User question: persist provider usage",
            "citations": [],
        }

    def fake_generate_answer(*_args, **_kwargs):
        return LlmCompletionResult(
            text="usage ok",
            usage={"prompt_tokens": 111, "completion_tokens": 29, "total_tokens": 140, "estimate": False},
        )

    monkeypatch.setattr(agent_ingress, "fetch_query_plan", fake_fetch_query_plan)
    monkeypatch.setattr(agent_ingress, "generate_answer", fake_generate_answer)

    response = client.post("/agent/chat", json={"message": "persist provider usage", "agent_id": agent_id})

    assert response.status_code == 200
    body = response.json()
    assert body["usage"] == {
        "prompt_tokens": 111,
        "completion_tokens": 29,
        "total_tokens": 140,
        "estimate": False,
    }

    with SessionLocal() as session:
        assistant_messages = list(
            session.scalars(select(AgentMessageRecord).where(AgentMessageRecord.role == "assistant"))
        )

    assert assistant_messages[-1].usage_json == {
        "prompt_tokens": 111,
        "completion_tokens": 29,
        "total_tokens": 140,
        "estimate": False,
    }


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


def test_build_staged_answer_directives_respects_conversation_mode() -> None:
    tool_plan = {"operation": "odoo.finance.margin.monthly_comparison"}

    quick = agent_ingress.build_staged_answer_directives(tool_plan=tool_plan, conversation_mode="quick")
    working_session = agent_ingress.build_staged_answer_directives(
        tool_plan=tool_plan,
        conversation_mode="working_session",
    )

    assert "Say CONTINUE" in quick
    assert "Say CONTINUE" not in working_session
    assert "working session mode" in working_session


def test_build_business_closeout_directives_for_finance_operator_request() -> None:
    directives = agent_ingress.build_business_closeout_directives(
        message="As of today give me up-to-date financials with Shopify orders and AOV.",
        tool_plan={"operation": "odoo.finance.shopify.monthly_roi", "payload": {"date_from": "2026-04-01", "date_to": "2026-04-19"}},
        tool_events=[
            agent_ingress.ChatToolEvent(
                tool_id="odoo_primary",
                status="executed",
                operation="odoo.finance.shopify.monthly_roi",
                summary="rows=2",
                payload={},
            )
        ],
    )
    assert "Business closeout constraints" in directives
    assert "do not reply with only blocker questions" in directives


def test_build_owner_operator_contract_directives_includes_sections_and_freshness() -> None:
    directives = agent_ingress.build_owner_operator_contract_directives(
        message="As of today give me up-to-date financials with Shopify orders and AOV.",
        tool_plan={"operation": "odoo.finance.shopify.monthly_roi", "payload": {"date_from": "2026-04-01", "date_to": "2026-04-19"}},
        tool_events=[
            agent_ingress.ChatToolEvent(
                tool_id="odoo_primary",
                status="executed",
                operation="odoo.finance.shopify.monthly_roi",
                summary="rows=2",
                payload={},
            )
        ],
    )
    assert "Owner-operator response contract" in directives
    assert "Facts" in directives and "Inferences" in directives and "Assumptions" in directives
    assert "Evidence window: 2026-04-01 -> 2026-04-19" in directives


def test_normalize_finance_closeout_answer_rewrites_blocking_response() -> None:
    normalized = agent_ingress.normalize_finance_closeout_answer(
        answer_text="I can't produce this yet. What I need from you is one more confirmation.",
        request_message="As of today give me up-to-date financials with Shopify orders and AOV.",
        tool_plan={"operation": "odoo.finance.shopify.monthly_roi", "payload": {"date_from": "2026-04-01", "date_to": "2026-04-19"}},
        tool_events=[
            agent_ingress.ChatToolEvent(
                tool_id="odoo_primary",
                status="executed",
                operation="odoo.finance.shopify.monthly_roi",
                summary="rows=2",
                payload={},
            )
        ],
    )
    assert "Executive Dashboard (Provisional" in normalized
    assert "Executed Odoo Evidence" in normalized


def test_normalize_finance_closeout_answer_injects_contract_sections_when_missing() -> None:
    normalized = agent_ingress.normalize_finance_closeout_answer(
        answer_text="Here is a short answer with no explicit structured sections.",
        request_message="As of today give me up-to-date financials with Shopify orders and AOV.",
        tool_plan={"operation": "odoo.finance.shopify.monthly_roi", "payload": {"date_from": "2026-04-01", "date_to": "2026-04-19"}},
        tool_events=[
            agent_ingress.ChatToolEvent(
                tool_id="odoo_primary",
                status="executed",
                operation="odoo.finance.shopify.monthly_roi",
                summary="rows=2",
                payload={},
            )
        ],
    )
    assert "Evidence window" in normalized
    assert "### Facts" in normalized
    assert "### Inferences" in normalized
    assert "### Assumptions" in normalized


def test_validate_docx_finalize_output_requires_structured_sections() -> None:
    diagnostics = agent_ingress.validate_docx_finalize_output(
        operation="finalize",
        answer_text="Facts: okay. Risks: present. Need more detail.",
    )
    assert diagnostics
    assert diagnostics[0]["code"] == "docx_finalize_validation_failed"


def test_validate_docx_finalize_output_allows_preview_without_sections() -> None:
    diagnostics = agent_ingress.validate_docx_finalize_output(
        operation="preview",
        answer_text="Short preview content.",
    )
    assert diagnostics == []


def test_build_owner_operator_questionnaire_directives_uses_guardrail_template() -> None:
    directives = agent_ingress.build_owner_operator_questionnaire_directives(
        guardrails_config={
            "owner_operator_questionnaire": "Q1: decision needed. Q2: scope.",
            "owner_operator_questionnaire_compact": "decision-first compact",
        }
    )
    assert "Owner-operator guidance template" in directives
    assert "Q1: decision needed" in directives
    assert "branch/location/store/site/shop" in directives


def test_normalize_business_abbreviations_expands_once() -> None:
    normalized = agent_ingress.normalize_business_abbreviations("ROAS improved while AOV held steady and COGS fell.")
    assert "return on ad spend (ROAS)" in normalized
    assert "average order value (AOV)" in normalized
    assert "cost of goods sold (COGS)" in normalized


def test_build_reporting_format_directives_for_strategy_and_finance() -> None:
    directives = agent_ingress.build_reporting_format_directives(
        message="Create a board strategy memo and financial report covering revenue, cogs, cashflow.",
        guardrails_config={},
    )
    assert "Formatting contract (mandatory)" in directives
    assert "board-ready business-plan structure" in directives
    assert "board reporting principles" in directives


def test_normalize_docx_finalize_answer_inserts_missing_sections() -> None:
    normalized = agent_ingress.normalize_docx_finalize_answer(
        operation="finalize",
        answer_text="### Facts\n- Revenue increased.",
        required_sections=["facts", "inferences", "assumptions", "risks", "actions"],
    )
    assert "### Inferences" in normalized
    assert "### Assumptions" in normalized
    assert "### Risks" in normalized
    assert "### Actions" in normalized


def test_prepare_tool_evidence_resolves_named_company_terms_before_finance_comparison(monkeypatch) -> None:
    _client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)

    def fake_execute_tool_operation_for_agent(*_args, **kwargs):
        operation = kwargs["operation"]
        if operation == "odoo.rpc.search_read":
            return (
                ToolExecuteResponse(
                    success=True,
                    message="ok",
                    operation=operation,
                    latency_ms=5,
                    data={
                        "records": [
                            {"id": 3, "name": "Ride Electric Retail"},
                            {"id": 4, "name": "Ride Electric Burleigh"},
                            {"id": 5, "name": "Ride Electric Brisbane"},
                        ]
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
        if operation == "odoo.finance.margin.monthly_comparison":
            assert kwargs["payload"]["company_ids"] == [3, 4, 5]
            return (
                ToolExecuteResponse(
                    success=True,
                    message="ok",
                    operation=operation,
                    latency_ms=12,
                    data={
                        "date_from": "2026-01-01",
                        "date_to": "2026-04-15",
                        "companies": [],
                        "rows": [],
                        "anomalies": [],
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

    monkeypatch.setattr(agent_ingress, "execute_tool_operation_for_agent", fake_execute_tool_operation_for_agent)

    with SessionLocal() as session:
        evidence = agent_ingress.prepare_tool_evidence(
            session,
            agent_id=agent_id,
            tool_overrides=None,
            tool_plan={
                "tool_id": "odoo_primary",
                "mode": "required",
                "operation": "odoo.finance.margin.monthly_comparison",
                "payload": {
                    "date_from": "2026-01-01",
                    "date_to": "2026-04-15",
                    "months": 4,
                    "company_name_terms": ["retail", "burleigh", "brisbane"],
                },
            },
        )

    assert evidence.plan["payload"]["company_ids"] == [3, 4, 5]
    assert evidence.tool_events[0].operation == "odoo.rpc.search_read"
    assert evidence.tool_events[1].operation == "odoo.finance.margin.monthly_comparison"
    assert "Resolved named company scope" in evidence.prompt_prefix


def test_prepare_tool_evidence_replaces_year_like_company_ids_with_named_company_resolution(monkeypatch) -> None:
    _client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)

    def fake_execute_tool_operation_for_agent(*_args, **kwargs):
        operation = kwargs["operation"]
        if operation == "odoo.rpc.search_read":
            return (
                ToolExecuteResponse(
                    success=True,
                    message="ok",
                    operation=operation,
                    latency_ms=4,
                    data={
                        "records": [
                            {"id": 3, "name": "Ride Electric Retail"},
                            {"id": 4, "name": "Ride Electric Burleigh"},
                        ]
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
        if operation == "odoo.finance.shopify.monthly_roi":
            assert kwargs["payload"]["company_ids"] == [3]
            assert kwargs["payload"]["company_id"] == 3
            return (
                ToolExecuteResponse(
                    success=True,
                    message="ok",
                    operation=operation,
                    latency_ms=9,
                    data={"line_count": 0, "rows": []},
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

    monkeypatch.setattr(agent_ingress, "execute_tool_operation_for_agent", fake_execute_tool_operation_for_agent)

    with SessionLocal() as session:
        evidence = agent_ingress.prepare_tool_evidence(
            session,
            agent_id=agent_id,
            tool_overrides=None,
            tool_plan={
                "tool_id": "odoo_primary",
                "mode": "required",
                "operation": "odoo.finance.shopify.monthly_roi",
                "payload": {
                    "date_from": "2024-07-01",
                    "date_to": "2026-07-01",
                    "company_ids": [2024, 2026],
                    "company_name_terms": ["retail"],
                },
            },
        )

    assert evidence.plan["payload"]["company_ids"] == [3]
    assert evidence.plan["payload"]["company_id"] == 3
    assert evidence.tool_events[0].operation == "odoo.rpc.search_read"
    assert evidence.tool_events[1].operation == "odoo.finance.shopify.monthly_roi"


def test_prepare_tool_evidence_adds_shopify_order_metrics_when_requested(monkeypatch) -> None:
    _client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)

    def fake_execute_tool_operation_for_agent(*_args, **kwargs):
        operation = kwargs["operation"]
        if operation == "odoo.finance.shopify.monthly_roi":
            return (
                ToolExecuteResponse(
                    success=True,
                    message="ok",
                    operation=operation,
                    latency_ms=8,
                    data={"date_from": "2026-04-01", "date_to": "2026-04-19", "companies": []},
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
        if operation == "odoo.sales.orders.search_read":
            return (
                ToolExecuteResponse(
                    success=True,
                    message="ok",
                    operation=operation,
                    latency_ms=5,
                    data={
                        "records": [
                            {"id": 1, "amount_total": 100.0, "company_id": [3, "Ride Electric Retail"]},
                            {"id": 2, "amount_total": 150.0, "company_id": [3, "Ride Electric Retail"]},
                        ]
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

    monkeypatch.setattr(agent_ingress, "execute_tool_operation_for_agent", fake_execute_tool_operation_for_agent)

    with SessionLocal() as session:
        evidence = agent_ingress.prepare_tool_evidence(
            session,
            agent_id=agent_id,
            tool_overrides=None,
            tool_plan={
                "tool_id": "odoo_primary",
                "mode": "required",
                "operation": "odoo.finance.shopify.monthly_roi",
                "payload": {
                    "date_from": "2026-04-01",
                    "date_to": "2026-04-19",
                    "company_ids": [3],
                },
            },
            request_message="Need Shopify orders and AOV for this period.",
        )

    assert any(event.operation == "odoo.sales.orders.search_read" for event in evidence.tool_events)
    assert "supplemental odoo order-level pull" in evidence.prompt_prefix.lower()


def test_agent_chat_working_session_avoids_continue_directive(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)
    captured_prompts: list[str] = []

    async def fake_fetch_query_plan(*args, **kwargs) -> dict:
        return {
            "query_mode": "semantic",
            "direct_answer": None,
            "prompt": "User question: Across Retail, Burleigh, Brisbane break down the year so far and who is the performer?",
            "citations": [],
            "tool_plan": {
                "tool_id": "odoo_primary",
                "mode": "required",
                "operation": "odoo.finance.margin.monthly_comparison",
                "payload": {"company_ids": [3, 4, 5], "months": 4},
                "reason": "Need the finance comparison.",
            },
        }

    def fake_execute_tool_operation_for_agent(*_args, **_kwargs):
        return (
            ToolExecuteResponse(
                success=True,
                message="ok",
                operation="odoo.finance.margin.monthly_comparison",
                latency_ms=8,
                data={"date_from": "2026-01-01", "date_to": "2026-04-15", "companies": [], "rows": [], "anomalies": []},
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

    def fake_generate_answer(prompt, *_args, **_kwargs):
        captured_prompts.append(prompt)
        return "working-session ok"

    monkeypatch.setattr(agent_ingress, "fetch_query_plan", fake_fetch_query_plan)
    monkeypatch.setattr(agent_ingress, "execute_tool_operation_for_agent", fake_execute_tool_operation_for_agent)
    monkeypatch.setattr(agent_ingress, "generate_answer", fake_generate_answer)

    response = client.post(
        "/agent/chat",
        json={
            "message": "Across Retail, Burleigh, Brisbane break down the year so far and who is the performer?",
            "agent_id": agent_id,
            "conversation_mode": "working_session",
        },
    )

    assert response.status_code == 200
    assert response.json()["conversation_mode"] == "working_session"
    assert captured_prompts
    assert "working session mode" in captured_prompts[0]
    assert "Say CONTINUE" not in captured_prompts[0]
