from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from ghostdash_api.agent_memory import save_agent, seed_default_agent_profiles
from ghostdash_api.database import Base
from ghostdash_api.runtime_profiles import get_default_runtime_profile, seed_default_runtime_profile
from ghostdash_api.workflow_runs import (
    create_workflow_run,
    list_workflow_steps,
    seed_workflow_definitions,
    update_workflow_step_run,
)


def build_session():
    engine = create_engine("sqlite:///:memory:", future=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)
    return SessionLocal


def test_create_workflow_run_persists_selected_agents() -> None:
    SessionLocal = build_session()

    with SessionLocal() as session:
        seed_default_runtime_profile(session)
        default_profile_id = get_default_runtime_profile(session).id
        seed_default_agent_profiles(session)
        seed_workflow_definitions(session)
        finance_agent = save_agent(
            session,
            {
                "name": "Finance Agent",
                "first_message": "Finance ready.",
                "language": "en-US",
                "voice_id": "alloy",
                "is_default": False,
                "enabled": True,
                "runtime_profile_id": default_profile_id,
            },
        )
        default_agent = next(agent for agent in session.query(type(finance_agent)).all() if agent.is_default)
        default_agent_id = default_agent.id
        finance_agent_id = finance_agent.id

        run = create_workflow_run(
            session,
            workflow_id="mas_consult_v1",
            surface="ghost_chatui",
            prompt="Summarise the risk tradeoffs.",
            agent_ids=[default_agent_id, finance_agent_id],
        )
        steps = list_workflow_steps(session, run.id)

    assert run.workflow_id == "mas_consult_v1"
    assert run.surface == "ghost_chatui"
    assert run.status == "queued"
    assert run.requested_agent_ids_json == [default_agent_id, finance_agent_id]
    assert [step.agent_name for step in steps] == ["GhostDASH Assistant", "Finance Agent"]


def test_update_workflow_step_run_rolls_up_run_status() -> None:
    SessionLocal = build_session()

    with SessionLocal() as session:
        seed_default_runtime_profile(session)
        default_profile_id = get_default_runtime_profile(session).id
        seed_default_agent_profiles(session)
        seed_workflow_definitions(session)
        finance_agent = save_agent(
            session,
            {
                "name": "Finance Agent",
                "first_message": "Finance ready.",
                "language": "en-US",
                "voice_id": "alloy",
                "is_default": False,
                "enabled": True,
                "runtime_profile_id": default_profile_id,
            },
        )
        default_agent = next(agent for agent in session.query(type(finance_agent)).all() if agent.is_default)
        default_agent_id = default_agent.id
        finance_agent_id = finance_agent.id
        run = create_workflow_run(
            session,
            workflow_id="mas_consult_v1",
            surface="ghost_chatui",
            prompt="Summarise the risk tradeoffs.",
            agent_ids=[default_agent_id, finance_agent_id],
        )
        first_step, second_step = list_workflow_steps(session, run.id)

        run = update_workflow_step_run(
            session,
            run_id=run.id,
            step_id=first_step.id,
            status="running",
        )
        assert run.status == "running"
        assert run.current_step == "GhostDASH Assistant"

        run = update_workflow_step_run(
            session,
            run_id=run.id,
            step_id=first_step.id,
            status="completed",
            conversation_id="conv-1",
            output_text="Assistant answer",
            citations=[{"filename": "source.pdf"}],
        )
        assert run.status == "running"
        assert run.progress == 0.5

        run = update_workflow_step_run(
            session,
            run_id=run.id,
            step_id=second_step.id,
            status="failed",
            error_message="Finance runtime unavailable",
        )

    assert run.status == "completed_with_errors"
    assert run.progress == 1.0
    assert run.result_json["step_counts"] == {
        "total": 2,
        "completed": 1,
        "failed": 1,
        "aborted": 0,
        "pending": 0,
        "running": 0,
    }


def test_create_workflow_run_materialises_head_agent_synthesis_step() -> None:
    SessionLocal = build_session()

    with SessionLocal() as session:
        seed_default_runtime_profile(session)
        default_profile_id = get_default_runtime_profile(session).id
        seed_default_agent_profiles(session)
        seed_workflow_definitions(session)
        finance_agent = save_agent(
            session,
            {
                "name": "Finance Agent",
                "first_message": "Finance ready.",
                "language": "en-US",
                "voice_id": "alloy",
                "is_default": False,
                "enabled": True,
                "runtime_profile_id": default_profile_id,
            },
        )
        operations_agent = save_agent(
            session,
            {
                "name": "Operations Agent",
                "first_message": "Ops ready.",
                "language": "en-US",
                "voice_id": "alloy",
                "is_default": False,
                "enabled": True,
                "runtime_profile_id": default_profile_id,
            },
        )
        default_agent = next(agent for agent in session.query(type(finance_agent)).all() if agent.is_default)
        default_agent_id = default_agent.id

        run = create_workflow_run(
            session,
            workflow_id="mas_consult_v1",
            surface="ghost_chatui",
            prompt="Summarise the risk tradeoffs.",
            agent_ids=[finance_agent.id, operations_agent.id],
            head_agent_id=default_agent_id,
        )
        steps = list_workflow_steps(session, run.id)

    assert [step.node_type for step in steps] == ["child_agent", "child_agent", "head_agent_synthesis"]
    assert [step.agent_name for step in steps] == ["Finance Agent", "Operations Agent", "GhostDASH Assistant"]
    assert run.result_json["workflow"] == {
        "name": "Head-Agent MAS Consult",
        "head_agent_id": default_agent_id,
        "head_agent_name": "GhostDASH Assistant",
    }
