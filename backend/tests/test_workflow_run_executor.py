from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from ghostdash_api.agent_memory import save_agent, seed_default_agent_profiles
from ghostdash_api.database import Base
from ghostdash_api.models import AgentProfileRecord
from ghostdash_api.runtime_profiles import seed_default_runtime_profile
from ghostdash_api.workflow_run_executor import execute_workflow_run
from ghostdash_api.workflow_runs import create_workflow_run, list_workflow_steps, seed_workflow_definitions


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def build_session_factory():
    engine = create_engine("sqlite:///:memory:", future=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)
    return SessionLocal


@pytest.mark.anyio
async def test_execute_workflow_run_completes_all_steps() -> None:
    SessionLocal = build_session_factory()

    with SessionLocal() as session:
        runtime_profile = seed_default_runtime_profile(session)
        seed_default_agent_profiles(session)
        seed_workflow_definitions(session)
        finance_agent = save_agent(
            session,
            {
                "name": "Finance Agent",
                "first_message": "Finance ready.",
                "language": "en-US",
                "voice_id": "alloy",
                "runtime_profile_id": runtime_profile.id,
                "is_default": False,
                "enabled": True,
            },
        )
        operations_agent = save_agent(
            session,
            {
                "name": "Operations Agent",
                "first_message": "Operations ready.",
                "language": "en-US",
                "voice_id": "alloy",
                "runtime_profile_id": runtime_profile.id,
                "is_default": False,
                "enabled": True,
            },
        )
        default_agent = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.is_default.is_(True)))
        assert default_agent is not None
        default_agent_id = default_agent.id
        finance_agent_id = finance_agent.id
        operations_agent_id = operations_agent.id
        run = create_workflow_run(
            session,
            workflow_id="mas_consult_v1",
            surface="ghost_chatui",
            prompt="Summarise the risk tradeoffs.",
            agent_ids=[finance_agent_id, operations_agent_id],
            head_agent_id=default_agent_id,
            result_json={
                "request": {
                    "api_mode": "responses",
                    "conversation_mode": "working_session",
                    "workflow_mode": "documenter",
                    "use_approved_web": False,
                }
            },
        )

    seen_messages: dict[str, str] = {}

    async def fake_consult_runner(
        *,
        message: str,
        agent_id: str,
        conversation_id: str | None,
        api_mode: str,
        conversation_mode: str,
        workflow_mode: str,
        use_approved_web: bool,
    ):
        seen_messages[agent_id] = message
        assert "Summarise the risk tradeoffs." in message
        assert api_mode == "responses"
        assert conversation_mode == "working_session"
        assert workflow_mode == "documenter"
        assert use_approved_web is False
        return {
            "answer": f"answer-for-{agent_id}",
            "query_mode": "semantic",
            "citations": [{"filename": "source.pdf"}],
            "conversation_id": f"conv-{agent_id}",
            "cached": False,
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "estimate": True},
        }

    await execute_workflow_run(run.id, consult_runner=fake_consult_runner, session_factory=SessionLocal)

    with SessionLocal() as session:
        refreshed_run = session.get(type(run), run.id)
        assert refreshed_run is not None
        steps = list_workflow_steps(session, run.id)

    assert refreshed_run.status == "completed"
    assert refreshed_run.progress == 1.0
    assert refreshed_run.result_json["completed_agents"] == 3
    assert refreshed_run.result_json["failed_agents"] == 0
    assert [step.status for step in steps] == ["completed", "completed", "completed"]
    assert [step.output_text for step in steps] == [
        f"answer-for-{finance_agent_id}",
        f"answer-for-{operations_agent_id}",
        f"answer-for-{default_agent_id}",
    ]
    assert all(step.metadata_json.get("conversation_mode") == "working_session" for step in steps)
    assert all(step.metadata_json.get("workflow_mode") == "documenter" for step in steps)
    assert "Finance Agent" in seen_messages[default_agent_id]
    assert "Operations Agent" in seen_messages[default_agent_id]
    assert "Do not attempt the final synthesis" in seen_messages[finance_agent_id]


@pytest.mark.anyio
async def test_execute_workflow_run_rolls_up_partial_failure() -> None:
    SessionLocal = build_session_factory()

    with SessionLocal() as session:
        runtime_profile = seed_default_runtime_profile(session)
        seed_default_agent_profiles(session)
        seed_workflow_definitions(session)
        finance_agent = save_agent(
            session,
            {
                "name": "Finance Agent",
                "first_message": "Finance ready.",
                "language": "en-US",
                "voice_id": "alloy",
                "runtime_profile_id": runtime_profile.id,
                "is_default": False,
                "enabled": True,
            },
        )
        operations_agent = save_agent(
            session,
            {
                "name": "Operations Agent",
                "first_message": "Operations ready.",
                "language": "en-US",
                "voice_id": "alloy",
                "runtime_profile_id": runtime_profile.id,
                "is_default": False,
                "enabled": True,
            },
        )
        default_agent = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.is_default.is_(True)))
        assert default_agent is not None
        default_agent_id = default_agent.id
        finance_agent_id = finance_agent.id
        operations_agent_id = operations_agent.id
        run = create_workflow_run(
            session,
            workflow_id="mas_consult_v1",
            surface="ghost_chatui",
            prompt="Summarise the risk tradeoffs.",
            agent_ids=[finance_agent_id, operations_agent_id],
            head_agent_id=default_agent_id,
            result_json={
                "request": {
                    "api_mode": "responses",
                    "conversation_mode": "board",
                    "workflow_mode": "odoo_specialist",
                    "use_approved_web": False,
                }
            },
        )

    async def flaky_consult_runner(
        *,
        message: str,
        agent_id: str,
        conversation_id: str | None,
        api_mode: str,
        conversation_mode: str,
        workflow_mode: str,
        use_approved_web: bool,
    ):
        if agent_id == finance_agent_id:
            raise RuntimeError("finance agent unavailable")
        assert conversation_mode == "board"
        assert workflow_mode == "odoo_specialist"
        return {
            "answer": "default-answer",
            "query_mode": "semantic",
            "citations": [],
            "conversation_id": "conv-default",
            "cached": False,
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "estimate": True},
        }

    await execute_workflow_run(run.id, consult_runner=flaky_consult_runner, session_factory=SessionLocal)

    with SessionLocal() as session:
        refreshed_run = session.get(type(run), run.id)
        assert refreshed_run is not None
        steps = list_workflow_steps(session, run.id)

    assert refreshed_run.status == "completed_with_errors"
    assert refreshed_run.result_json["completed_agents"] == 2
    assert refreshed_run.result_json["failed_agents"] == 1
    assert [step.status for step in steps] == ["failed", "completed", "completed"]
    assert steps[0].error_message == "finance agent unavailable"
    assert steps[0].metadata_json["conversation_mode"] == "board"
    assert steps[0].metadata_json["workflow_mode"] == "odoo_specialist"
