from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from ghostdash_api.agent_memory import save_agent, seed_default_agent_profiles
from ghostdash_api.database import Base
from ghostdash_api.runtime_profiles import get_default_runtime_profile, seed_default_runtime_profile
from ghostdash_api.workflow_runs import (
    create_workflow_run,
    list_workflow_steps,
    replay_workflow_run_state_from_events,
    seed_workflow_definitions,
    update_workflow_run,
    update_workflow_step_run,
)


def build_session():
    engine = create_engine("sqlite:///:memory:", future=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)
    return SessionLocal


def test_replay_workflow_run_state_from_events_reconstructs_terminal_status() -> None:
    SessionLocal = build_session()
    with SessionLocal() as session:
        seed_default_runtime_profile(session)
        default_profile_id = get_default_runtime_profile(session).id
        seed_default_agent_profiles(session)
        seed_workflow_definitions(session)
        sub_a = save_agent(
            session,
            {
                "name": "Sub A",
                "first_message": "sub a",
                "language": "en-US",
                "voice_id": "alloy",
                "runtime_profile_id": default_profile_id,
                "enabled": True,
            },
        )
        sub_b = save_agent(
            session,
            {
                "name": "Sub B",
                "first_message": "sub b",
                "language": "en-US",
                "voice_id": "alloy",
                "runtime_profile_id": default_profile_id,
                "enabled": True,
            },
        )
        lead = next(agent for agent in session.query(type(sub_a)).all() if agent.is_default)
        run = create_workflow_run(
            session,
            workflow_id="mas_consult_v1",
            surface="ghost_chatui",
            prompt="Test replay path",
            agent_ids=[sub_a.id, sub_b.id],
            head_agent_id=lead.id,
        )
        first_step = list_workflow_steps(session, run.id)[0]
        update_workflow_step_run(session, run_id=run.id, step_id=first_step.id, status="running")
        update_workflow_step_run(session, run_id=run.id, step_id=first_step.id, status="completed")
        update_workflow_run(session, run_id=run.id, status="completed")
        replayed = replay_workflow_run_state_from_events(session, run.id)
    assert replayed["status"] == "completed"
    assert replayed["last_sequence"] > 0
    assert any(task["status"] == "completed" for task in replayed["tasks"].values())

